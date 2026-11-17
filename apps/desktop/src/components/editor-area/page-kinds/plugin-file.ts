import { resolveFileView } from "@/lib/file-views";
import { getFileName } from "@/lib/paths";
import { definePageKind } from "./types";

/**
 * A vault file shown by a community plugin's view (`registerExtensions`, or a note a plugin
 * redirects into its own view, like an Excalidraw drawing). `viewType` names the registered view;
 * the tab body creates the plugin leaf for `path` and the leaf lives and dies with the tab.
 */
export type PluginFileLocation = { kind: "plugin-file"; path: string; viewType: string };

/** Obsidian's tab title: the file name without a trailing `.md` (`.excalidraw` stays). */
const titleOf = (path: string): string => getFileName(path).replace(/\.md$/i, "");

// The plugin reads and writes the file through the vault itself, so the editor store never loads
// it as a document (`loadsDocument: false`). `forPath` asks the plugins (`resolveFileView`), so a
// path opens in its plugin view from every entry point; with the plugin disabled it claims
// nothing and the file opens as text. The view (PluginFileTab) is registered in `./views`.
export const pluginFileKind = definePageKind<"plugin-file", PluginFileLocation>({
  kind: "plugin-file",
  title: (l) => titleOf(l.path),
  description: "File shown by a plugin view",
  keepAlive: true,
  supportsFileContextMenu: true,
  loadsDocument: false,
  forPath: (path) => {
    const viewType = resolveFileView(path);
    return viewType ? { kind: "plugin-file", path, viewType } : null;
  },
  fromPayload: (data) =>
    typeof data.path === "string" && typeof data.viewType === "string" && data.viewType
      ? { kind: "plugin-file", path: data.path, viewType: data.viewType }
      : null,
  paths: (l) => [l.path],
  primaryPath: (l) => l.path,
  rewritePath: (l, from, to) => (l.path === from ? { ...l, path: to } : l),
  removePath: (l, path) => (l.path === path ? null : l),
  serialize: (l) => ({ path: l.path, viewType: l.viewType }),
});
