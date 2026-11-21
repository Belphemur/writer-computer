// The Git feature (spec `SPECs/git-sync-spec.md`, ADR 2026-11-18 "sync vaults with a built-in Git
// feature"), phase 1: local version history. The engine, the cadence and the commits are the Rust
// half (`../rust/`, the engine in `crate::git`); this half is the status item, the sidebar panel,
// the Settings > Git page and two commands. Loaded at startup, so it imports only `defineFeature`,
// the manifest, the tiny status store and `import()` thunks.
import { GitCommitIcon } from "@hugeicons/core-free-icons";
import { openSettings } from "@/hooks/editor-api";
import { defineFeature } from "@/lib/features/registry";
import manifest from "../feature.json";
import { commitNow, GIT_CHANGED } from "./ipc";
import { startStatusSync, useGitStatus } from "./lib/status-store";

export const GIT_SECTION_ID = "git";

const hasVault = (c: { hasWorkspace: boolean; isCompactFileMode: boolean }) =>
  c.hasWorkspace && !c.isCompactFileMode;

export default defineFeature({
  id: manifest.id,
  activate(ctx) {
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
        id: "git.settings",
        label: "Version history settings",
        description: "Choose when versions are saved",
        when: hasVault,
        run: () => openSettings(GIT_SECTION_ID),
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
