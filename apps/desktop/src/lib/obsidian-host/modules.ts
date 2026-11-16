// Adapted from opensidian (GPL-3.0-or-later).
// The CommonJS `require` plugins get: `obsidian` -> the shim, CodeMirror/Lezer -> the app's own
// module instances (so an extension built against them shares classes with the editor; the public
// sample plugin's esbuild externals also list @codemirror/collab, which Writer does not ship, so
// that one stays an UnsupportedModuleError), the Node
// surface (node/), and `Cannot find module` (MODULE_NOT_FOUND) for everything else.
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
import * as lezerLr from "@lezer/lr";
import * as lezerMarkdown from "@lezer/markdown";
import * as lezerYaml from "@lezer/yaml";
import type { VaultIo } from "./api/vault";
import { pluginIdFromStack } from "./node/child-process";
import { createNodeRegistry, type NodeRegistry } from "./node/registry";

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
  "@lezer/lr": lezerLr,
  "@lezer/markdown": lezerMarkdown,
  "@lezer/yaml": lezerYaml,
});

export class UnsupportedModuleError extends Error {
  constructor(pluginId: string, name: string, why: string) {
    super(`${pluginId}: require("${name}") ${why}`);
    this.name = "UnsupportedModuleError";
  }
}

export interface MakeRequireContext {
  /** Vault IO backing the confined async `fs`. */
  io?: VaultIo;
  /**
   * The host-level `require` installed as a global: code that calls the bare global `require`
   * (bundled SDKs) cannot be told apart by closure, so the calling plugin is resolved from the
   * call stack when a Node API needs an identity (spawn consent).
   */
  global?: boolean;
}

/** Builds the `require` for one plugin. `obsidianApi` is the shared `obsidian` module object. */
export function makeRequire(
  pluginId: string,
  obsidianApi: unknown,
  ctx: MakeRequireContext = {},
): RequireFn {
  let registry: NodeRegistry;
  const require: RequireFn = (rawName: string): unknown => {
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
    if (registry.has(name)) return registry.get(name);
    throw Object.assign(new Error(`Cannot find module '${name}'`), {
      code: "MODULE_NOT_FOUND",
      requireStack: [],
    });
  };
  // `node:module`.createRequire hands back this very function.
  registry = createNodeRegistry({
    pluginId: ctx.global ? () => pluginIdFromStack(new Error().stack) : pluginId,
    io: ctx.io,
    require,
  });
  return require;
}
