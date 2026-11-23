// The Git feature (spec `SPECs/git-sync-spec.md`, ADR 2026-11-18 "sync vaults with a built-in Git
// feature"), phase 1: local version history. The engine, the cadence and the commits are the Rust
// half (`../rust/`, the engine in `crate::git`); this half is the status item, the sidebar panel,
// the Settings > Git page and two commands. Loaded at startup, so it imports only `defineFeature`,
// the manifest, the tiny status store and `import()` thunks.
import { GitCommitIcon } from "@hugeicons/core-free-icons";
import { openLocationTab, openSettings } from "@/hooks/editor-api";
import { defineFeature } from "@/lib/features/registry";
import manifest from "../feature.json";
import { GIT_HISTORY, type GitHistoryService } from "./api";
import { cancelSave, holdSaves, waitForSave } from "@/lib/save";
import { registerExternalChangeClaim } from "@/lib/external-changes";
import { findEditorView } from "@/lib/editor-views";
import { getWorkspaceRoot } from "@/hooks/workspace-api";
import { readFile } from "@/lib/tauri";
import { logger } from "@/lib/logger";
import * as editorApi from "@/hooks/editor-api";
import {
  type ApplyingPayload,
  commitNow,
  conflictRecord,
  conflictTake,
  GIT_APPLYING,
  GIT_CHANGED,
  mergeText,
  syncNow,
  turnCommit,
} from "./ipc";
import { createApplier } from "./lib/remote-apply";
import { showHistoryItems } from "./menus";
import { startStatusSync, useGitStatus } from "./lib/status-store";
import { resolveConflicts } from "./lib/resolve-conflicts";

export const GIT_SECTION_ID = "git";

/** Who asked `onCommit`; told by the store subscription `activate` makes on `ctx`. */
const commitListeners = new Set<() => void>();

/** What other features use to open a file's history (`api.ts`). */
const historyService: GitHistoryService = {
  openHistory: (path, options) =>
    openLocationTab(
      { kind: "git-history", path, rev: options?.rev },
      { activate: options?.activate },
    ),
  commitForTurn: (t) =>
    turnCommit(t.chatId, t.turnId, t.finishedAt === null ? null : Math.floor(t.finishedAt / 1000)),
  onCommit: (listener) => {
    commitListeners.add(listener);
    return () => void commitListeners.delete(listener);
  },
};

const hasVault = (c: { hasWorkspace: boolean; isCompactFileMode: boolean }) =>
  c.hasWorkspace && !c.isCompactFileMode;

export default defineFeature({
  id: manifest.id,
  activate(ctx) {
    ctx.onDispose(() => commitListeners.clear());
    ctx.subscribe(useGitStatus, (s, prev) => {
      if (s.status?.lastCommit !== prev.status?.lastCommit) {
        for (const l of [...commitListeners]) l();
      }
    });
    // a sync's writes reach open notes politely: after the typing idle, as one undo step
    const applier = createApplier({
      root: getWorkspaceRoot,
      every: (fn, ms) => ctx.setInterval(fn, ms),
      onError: () => logger.warn("git", "could not apply a synced change to an open note"),
      deps: {
        getOpenFile: editorApi.getOpenFile,
        readFile: async (path) => (await readFile(path)).content,
        mergeText,
        findView: findEditorView,
        updateFrontmatter: editorApi.updateFrontmatter,
        updateContent: editorApi.updateContent,
        markSaved: editorApi.markSaved,
        cancelSave,
        holdSaves,
        waitForSave,
        recordConflict: async (path, base, mine) => {
          useGitStatus.getState().apply(await conflictRecord(path, base, mine));
        },
      },
    });
    ctx.onDispose(registerExternalChangeClaim((path) => applier.claim(path, "")));
    ctx.listen<ApplyingPayload>(GIT_APPLYING, (p) =>
      p.done ? applier.done(p.paths) : applier.announce(p.paths),
    );
    return startStatusSync(
      (onChange) => ctx.listen(GIT_CHANGED, onChange),
      (fn, ms) => ctx.setInterval(fn, ms),
    );
  },
  contributes: {
    commands: [
      {
        id: "git.commit-now",
        label: "Save a version now",
        description: "Commit the pending changes",
        when: (ctx) => hasVault(ctx) && useGitStatus.getState().status?.setUp === true,
        run: async () => {
          useGitStatus.getState().apply(await commitNow());
        },
      },
      {
        id: "git.show-history",
        label: "Show history",
        description: "Open the version history of the active file",
        when: (ctx) =>
          hasVault(ctx) &&
          ctx.activeFilePath !== null &&
          useGitStatus.getState().status?.setUp === true,
        run: (ctx) => {
          if (ctx.activeFilePath)
            openLocationTab({ kind: "git-history", path: ctx.activeFilePath });
        },
      },
      {
        id: "git.resolve-conflicts",
        label: "Resolve conflicts",
        description: "Open the merge view of a file two devices changed",
        when: (ctx) =>
          hasVault(ctx) &&
          ((s) => (s?.conflicts.length ?? 0) + (s?.copies.length ?? 0) > 0)(
            useGitStatus.getState().status,
          ),
        run: (ctx) => resolveConflicts(ctx.activeFilePath),
      },
      {
        id: "git.settings",
        label: "Version history settings",
        description: "Choose when versions are saved",
        when: hasVault,
        run: () => openSettings(GIT_SECTION_ID),
      },
    ],
    menus: {
      "sidebar-file": [{ id: "git.sidebar-file", items: (entry) => showHistoryItems(entry.path) }],
      "editor-tab": [{ id: "git.editor-tab", items: (path) => showHistoryItems(path) }],
    },
    // The body of the History tab (the `git-history` page kind lives in core; with the feature
    // off the tab shows "turned off").
    slots: [
      {
        id: "git.history-tab",
        slot: "page-view:git-history",
        load: () => import("./components/history-page").then((m) => m.default),
      },
      // The body of the merge view (the `git-merge` page kind lives in core)
      {
        id: "git.merge-tab",
        slot: "page-view:git-merge",
        load: () => import("./components/merge-page").then((m) => m.default),
      },
      // "Changed on another device — Resolve" over an open note in conflict
      {
        id: "git.note-bar",
        slot: "note-bar",
        load: () => import("./components/note-bar").then((m) => m.default),
      },
    ],
    services: [{ id: GIT_HISTORY, service: historyService }],
    ipcRequests: [
      {
        id: "git.resolve",
        topic: "git:resolve",
        // `writer git:resolve` while the app has the vault open: the merge view's own command
        handle: async (args: unknown) => {
          const { path, take } = args as { path: string; take: "mine" | "theirs" | "both" };
          try {
            useGitStatus.getState().apply(await conflictTake(path, take));
            return { error: null };
          } catch (e) {
            return { error: e instanceof Error ? e.message : String(e) };
          }
        },
      },
      {
        id: "git.sync",
        topic: "git:sync",
        // `writer git:sync` while the app runs: the app's sync, the answer the CLI prints
        handle: async () => {
          const s = await syncNow();
          useGitStatus.getState().apply(s);
          return {
            pushed: s.lastPushed,
            pulled: s.lastPulled,
            conflicted: s.conflicts.map((c) => c.path),
            ahead: s.ahead,
            behind: s.behind,
            error: s.syncError?.line ?? null,
          };
        },
      },
    ],
    statusItems: [
      {
        id: "git.status",
        order: 30,
        load: () => import("./components/status-item").then((m) => m.default),
      },
    ],
    sidebarPanels: [
      {
        id: "git.panel",
        label: "Versions",
        icon: GitCommitIcon,
        order: 30,
        load: () => import("./components/panel").then((m) => m.default),
      },
    ],
    settingsSection: {
      id: GIT_SECTION_ID,
      label: "Git",
      order: 44,
      requiresWorkspace: true,
      load: () => import("./components/git-section").then((m) => ({ default: m.GitSection })),
    },
  },
});
