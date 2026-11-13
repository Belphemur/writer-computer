// Adapted from opensidian (GPL-3.0-or-later).
// The CommonJS `require` plugins get: `obsidian` -> the shim, CodeMirror/Lezer -> the app's own
// module instances (so an extension built against them shares classes with the editor), a few
// Node leaves, and a clear error for everything else.
import * as cmAutocomplete from "@codemirror/autocomplete";
import * as cmCommands from "@codemirror/commands";
import * as cmLangMarkdown from "@codemirror/lang-markdown";
import * as cmLanguage from "@codemirror/language";
import * as cmLint from "@codemirror/lint";
import * as cmSearch from "@codemirror/search";
import * as cmState from "@codemirror/state";
import * as cmView from "@codemirror/view";
import * as lezerCommon from "@lezer/common";
import * as lezerHighlight from "@lezer/highlight";
import * as lezerMarkdown from "@lezer/markdown";
import * as lezerYaml from "@lezer/yaml";
import { fsPromisesShim, fsShim, pathShim } from "./node-shims";

export type RequireFn = (name: string) => unknown;

const APP_MODULES: Readonly<Record<string, unknown>> = Object.freeze({
  "@codemirror/autocomplete": cmAutocomplete,
  "@codemirror/commands": cmCommands,
  "@codemirror/lang-markdown": cmLangMarkdown,
  "@codemirror/language": cmLanguage,
  "@codemirror/lint": cmLint,
  "@codemirror/search": cmSearch,
  "@codemirror/state": cmState,
  "@codemirror/view": cmView,
  "@lezer/common": lezerCommon,
  "@lezer/highlight": lezerHighlight,
  "@lezer/markdown": lezerMarkdown,
  "@lezer/yaml": lezerYaml,
});

const NODE_LEAVES: Readonly<Record<string, unknown>> = Object.freeze({
  path: pathShim,
  "path/posix": pathShim.posix,
  fs: fsShim,
  "fs/promises": fsPromisesShim,
});

export class UnsupportedModuleError extends Error {
  constructor(pluginId: string, name: string, why: string) {
    super(`${pluginId}: require("${name}") ${why}`);
    this.name = "UnsupportedModuleError";
  }
}

/** Builds the `require` for one plugin. `obsidianApi` is the shared `obsidian` module object. */
export function makeRequire(pluginId: string, obsidianApi: unknown): RequireFn {
  return (rawName: string): unknown => {
    const name = String(rawName);
    if (name === "obsidian") return obsidianApi;
    if (Object.prototype.hasOwnProperty.call(APP_MODULES, name)) return APP_MODULES[name];
    if (name.startsWith("@codemirror/") || name.startsWith("@lezer/")) {
      throw new UnsupportedModuleError(
        pluginId,
        name,
        "is not supported: Writer does not provide this editor module",
      );
    }
    const bare = name.startsWith("node:") ? name.slice(5) : name;
    if (Object.prototype.hasOwnProperty.call(NODE_LEAVES, bare)) return NODE_LEAVES[bare];
    throw new UnsupportedModuleError(
      pluginId,
      name,
      "is not supported in Writer (no Node.js built-ins are available to plugins)",
    );
  };
}
