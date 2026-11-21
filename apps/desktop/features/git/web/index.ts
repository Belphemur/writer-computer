// The Git feature (spec `SPECs/git-sync-spec.md`, ADR 2026-11-18 "sync vaults with a built-in Git
// feature"), phase 1: local version history. The engine, the cadence and the commits are the Rust
// half (`../rust/`, the engine in `crate::git`); this half is the status item, the sidebar panel,
// the Settings > Git page and two commands. Loaded at startup, so it imports only `defineFeature`,
// the manifest, the tiny status store and `import()` thunks.
import { GitCommitIcon } from "@hugeicons/core-free-icons";
import { openGitHistoryTab, openSettings } from "@/hooks/editor-api";
import { defineFeature } from "@/lib/features/registry";
import manifest from "../feature.json";
import { GIT_HISTORY, type GitHistoryService } from "./api";
import { commitNow, GIT_CHANGED, turnCommit } from "./ipc";
import { showHistoryItems } from "./menus";
import { startStatusSync, useGitStatus } from "./lib/status-store";

export const GIT_SECTION_ID = "git";

/** Who asked `onCommit`; told by the store subscription `activate` makes on `ctx`. */
const commitListeners = new Set<() => void>();

/** What other features use to open a file's history (`api.ts`). */
const historyService: GitHistoryService = {
  openHistory: (path, options) =>
    openGitHistoryTab({ path, rev: options?.rev }, { activate: options?.activate }),
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
    return startStatusSync((onChange) => ctx.listen(GIT_CHANGED, onChange));
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
          if (ctx.activeFilePath) openGitHistoryTab({ path: ctx.activeFilePath });
        },
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
    ],
    services: [{ id: GIT_HISTORY, service: historyService }],
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
