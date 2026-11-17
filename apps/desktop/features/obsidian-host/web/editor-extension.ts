// What the Obsidian host adds to every editor, contributed through the feature editor-extension
// compartment (`lib/features/editor-extensions.ts`): the markdown processors' widgets, the guard
// that validates plugin extensions, and the shared compartment the plugins' own extensions go in
// (reconfigured live by `setPluginEditorExtensions`).
import { Prec, type Extension } from "@codemirror/state";
import {
  getPluginCompartmentValue,
  pluginConfigGuard,
  pluginExtensionCompartment,
} from "./host/editor-bridge";
import { pluginMarkdownDecorations } from "./plugin-markdown-decorations";

export function pluginEditorExtension(): Extension {
  return [
    // After the core fenced-block decorations (callouts, mermaid, base embeds), as before the
    // move: the first provider to claim a fence wins.
    Prec.low(pluginMarkdownDecorations()),
    pluginConfigGuard,
    pluginExtensionCompartment.of(getPluginCompartmentValue()),
  ];
}
