import { definePageKind } from "./types";

/**
 * A view a community plugin opened in a main-area leaf (`workspace.getLeaf(true | "tab")`), shown
 * as an editor tab. `leafId` names the live `WorkspaceLeaf` in the plugins store; `title` mirrors
 * the view's `getDisplayText()` (the plugins store re-titles the tab when the view changes it).
 */
export type PluginViewLocation = {
  kind: "plugin-view";
  leafId: string;
  title: string;
};

// Transient: a leaf cannot outlive the host that created it, so the tab is never persisted.
// The view (PluginViewTab) is registered in `./views`.
export const pluginViewKind = definePageKind<"plugin-view", PluginViewLocation>({
  kind: "plugin-view",
  title: (l) => l.title || "Plugin view",
  description: "A view opened by a community plugin",
  serialize: () => null,
});
