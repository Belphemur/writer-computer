// WorkspaceBridge implementation: connects the shim's Workspace to the app.
//
// Pure adapter. Leaves placed "left"/"right" show in the plugin side pane; "main" leaves are
// editor-area tabs (page kind `plugin-view`). Everything stateful (which leaves exist, whether the pane is open) lives in the
// plugins store and reaches this module through `PluginPane`; everything about the app's editor
// and tabs arrives through `AppWorkspace`. Both are injected so the bridge is testable in node.
// Types only from the shim: this module must stay cheap to import (the shim itself is lazy).
import type { EditorView } from "@codemirror/view";
import type { LeafPlacement, WorkspaceBridge, WorkspaceLeaf } from "./api/views";
import { editorBackendFor, reapplyPluginEditorExtensions } from "./editor-bridge";

/** Where leaves are shown. Implemented by the plugins store. */
export interface PluginPane {
  mountLeaf(leaf: WorkspaceLeaf, placement: LeafPlacement): void;
  revealLeaf(leaf: WorkspaceLeaf): void;
  leafChanged(leaf: WorkspaceLeaf): void;
  detachLeaf(leaf: WorkspaceLeaf): void;
  /** The leaf whose editor tab is the active tab, or null. */
  activePluginLeaf(): WorkspaceLeaf | null;
  /** The tab bound to `leaf` shows `path` (vault-relative) as text. */
  showLeafAsText?(leaf: WorkspaceLeaf, path: string): Promise<void>;
  /** The active tab shows `path` (vault-relative) through the view registered as `type`. */
  showFileAsView?(path: string, type: string): Promise<void>;
}

/** What the bridge needs to know about the open workspace and its editors. */
export interface AppWorkspace {
  /** Absolute workspace root, or null when none is open. */
  getRoot(): string | null;
  /** Absolute path of the active document. */
  getActiveFilePath(): string | null;
  /** The CodeMirror view showing `absPath`. */
  getEditorView(absPath: string | null): EditorView | null;
  /** Opens `absPath` in the current tab, or in a new tab (a background one when `activate` is
   *  false; the default is to activate it), then reveals `anchor` (a heading slug or base view
   *  name, `linkAnchor`) when given. */
  openFile(
    absPath: string,
    opts: { newLeaf: boolean; activate?: boolean; anchor?: string },
  ): Promise<void>;
}

export function toVaultPath(root: string, absPath: string): string | null {
  const base = root.replace(/\/+$/, "");
  return absPath.startsWith(`${base}/`) ? absPath.slice(base.length + 1) : null;
}

export function toAbsolutePath(root: string, vaultPath: string): string {
  return `${root.replace(/\/+$/, "")}/${vaultPath.replace(/^\/+/, "")}`;
}

export function createWorkspaceBridge(app: AppWorkspace, pane: PluginPane): WorkspaceBridge {
  return {
    mountLeaf: (leaf, placement) => pane.mountLeaf(leaf, placement),
    revealLeaf: (leaf) => pane.revealLeaf(leaf),
    leafChanged: (leaf) => pane.leafChanged(leaf),
    detachLeaf: (leaf) => pane.detachLeaf(leaf),
    getActivePluginLeaf: () => pane.activePluginLeaf(),
    showLeafAsText: pane.showLeafAsText && ((leaf, path) => pane.showLeafAsText!(leaf, path)),
    showFileAsView: pane.showFileAsView && ((path, type) => pane.showFileAsView!(path, type)),
    reapplyEditorOptions: reapplyPluginEditorExtensions,
    getActiveFilePath() {
      const root = app.getRoot();
      const active = app.getActiveFilePath();
      return root && active ? toVaultPath(root, active) : null;
    },
    getActiveEditor() {
      const view = app.getEditorView(app.getActiveFilePath());
      return view ? editorBackendFor(view) : null;
    },
    async openFile(path, opts) {
      const root = app.getRoot();
      if (!root) throw new Error("openFile: no workspace is open");
      await app.openFile(toAbsolutePath(root, path), opts);
    },
  };
}
