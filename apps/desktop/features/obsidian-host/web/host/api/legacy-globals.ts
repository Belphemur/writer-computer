// Globals Obsidian leaves on `window` that community plugins read bare, without importing them:
//   - `window.moment` (the same moment.js the `obsidian` module exports),
//   - `window.app` / bare `app` (deprecated but still used by plugins such as Text Extractor),
//   - `window.CodeMirror` and `window.CodeMirrorAdapter`: the legacy CodeMirror 5 and Vim-mode
//     globals. Writer's editor is CodeMirror 6, so these are INERT registries: a plugin that
//     registers a mode, helper, command or Vim mapping at load does not crash, nothing renders
//     from them. `getMode` returns a token-skipping stand-in (named after the registered mode) and
//     never runs a mode factory, so no CM5 mode code executes.
// Installed while a plugin is loaded (with the DOM helpers) and removed afterwards; a global the
// page already defines is left alone and never removed.
import { moment } from "./functions";

type Fn = (...args: any[]) => unknown;
type Registry = Record<string, any>;

const NULL_MODE = "null";

/** CM5 `Pos`: a `{line, ch}` position with `sticky`. */
function Pos(
  this: { line: number; ch: number; sticky: unknown },
  line: number,
  ch: number,
  sticky = null,
) {
  if (!((this instanceof Pos) as unknown as new () => object))
    return new (Pos as unknown as new (l: number, c: number, s: unknown) => object)(
      line,
      ch,
      sticky,
    );
  this.line = line;
  this.ch = ch;
  this.sticky = sticky;
}

/** The inert CM5 mode returned for any spec: consumes the line, styles nothing. */
function inertMode(name: string): Registry {
  return {
    name,
    token(stream: { skipToEnd(): void }) {
      stream.skipToEnd();
      return null;
    },
  };
}

/** Builds a fresh CM5 global (one per install). Exported for tests. */
export function createCodeMirror5(): Registry {
  const modes: Registry = {};
  const mimeModes: Registry = {};
  const helpers: Record<string, Registry> = {};
  const globalHelpers: Registry = {};
  const defaults: Registry = {};
  const optionHandlers: Registry = {};
  const initHooks: Fn[] = [];
  const Pass = { toString: () => "CodeMirror.Pass" };

  const resolveMode = (spec: unknown): { name: string; [k: string]: unknown } => {
    let s = spec;
    for (let i = 0; i < 8; i++) {
      // A MIME alias can point at another alias or a spec object; bound the chain.
      if (typeof s === "string" && Object.prototype.hasOwnProperty.call(mimeModes, s))
        s = mimeModes[s];
      else break;
    }
    if (typeof s === "string") return { name: s };
    if (s && typeof s === "object" && typeof (s as { name?: unknown }).name === "string")
      return s as { name: string };
    return { name: NULL_MODE };
  };

  const CodeMirror: Registry = {
    version: "5.65.0",
    modes,
    mimeModes,
    commands: {},
    keyMap: { default: {}, basic: {}, pcDefault: {}, macDefault: {} },
    helpers,
    defaults,
    optionHandlers,
    Pos,
    Pass,
    Init: { toString: () => "CodeMirror.Init" },
    defineMode(name: string, factory: unknown): void {
      if (name !== NULL_MODE && defaults.mode === undefined) defaults.mode = name;
      modes[name] = factory;
    },
    defineMIME(mime: string, spec: unknown): void {
      mimeModes[mime] = spec;
    },
    extendMode(name: string, props: Registry): void {
      const factory = modes[name];
      if (factory) Object.assign(factory.prototype ?? factory, props);
    },
    resolveMode,
    getMode(_options: unknown, spec: unknown): Registry {
      const resolved = resolveMode(spec);
      const known = Object.prototype.hasOwnProperty.call(modes, resolved.name);
      return inertMode(known ? resolved.name : NULL_MODE);
    },
    listModes: () => Object.keys(modes),
    listMIMEs: () => Object.keys(mimeModes).map((mime) => ({ mime, mode: mimeModes[mime] })),
    registerHelper(type: string, name: string, value: unknown): void {
      (helpers[type] ??= { _global: [] })[name] = value;
    },
    registerGlobalHelper(type: string, name: string, predicate: Fn, value: unknown): void {
      CodeMirror.registerHelper(type, name, value);
      helpers[type]._global.push({ pred: predicate, val: value });
      globalHelpers[`${type}\0${name}`] = predicate;
    },
    defineOption(name: string, deflt: unknown, handler?: unknown): void {
      defaults[name] = deflt;
      if (handler) optionHandlers[name] = handler;
    },
    defineInitHook(hook: Fn): void {
      initHooks.push(hook);
    },
    defineExtension(name: string, fn: unknown): void {
      (CodeMirror.prototype as Registry)[name] = fn;
    },
    defineDocExtension(name: string, fn: unknown): void {
      (CodeMirror.Doc.prototype as Registry)[name] = fn;
    },
    startState(mode: Registry, a1?: unknown, a2?: unknown): unknown {
      return typeof mode.startState === "function" ? mode.startState(a1, a2) : true;
    },
    copyState(mode: Registry, state: unknown): unknown {
      if (state === true || state === false) return state;
      if (typeof mode.copyState === "function") return mode.copyState(state);
      if (!state || typeof state !== "object") return state;
      const copy: Registry = {};
      for (const [k, v] of Object.entries(state)) copy[k] = Array.isArray(v) ? v.concat([]) : v;
      return copy;
    },
    // Editor construction is a CM5-only path: fail loudly instead of returning a fake editor.
    fromTextArea(): never {
      throw new Error("CodeMirror 5 editors are not available in Writer (CodeMirror 6 only)");
    },
  };
  // Shells so `defineExtension` / `defineDocExtension` have somewhere to store.
  CodeMirror.prototype = {};
  CodeMirror.Doc = function Doc() {};
  CodeMirror.Doc.prototype = {};
  return CodeMirror;
}

/** CM5 Vim keymap API surface that plugins define commands against; every call is inert. */
const VIM_REGISTRY_CALLS = [
  "defineEx",
  "defineAction",
  "defineMotion",
  "defineOperator",
  "defineRegister",
  "map",
  "noremap",
  "mapCommand",
  "_mapCommand",
] as const;
const VIM_NOOP_CALLS = [
  "handleKey",
  "handleEx",
  "unmap",
  "mapclear",
  "exitInsertMode",
  "exitVisualMode",
  "enterVimMode",
  "leaveVimMode",
  "resetVimGlobalState_",
  "suppressErrorLogging",
] as const;

/** Builds `window.CodeMirrorAdapter` (the Vim adapter): `commands`, `Vim`, `Pos`, `keyMap`. */
export function createCodeMirrorAdapter(): Registry {
  const defined: Record<string, unknown[][]> = {};
  const options: Registry = {};
  const Vim: Registry = {
    defined,
    defineOption(name: string, deflt: unknown): void {
      options[name] = deflt;
    },
    setOption(name: string, value: unknown): void {
      options[name] = value;
    },
    getOption: (name: string): unknown => options[name],
    getRegisterController: () => ({ registers: {} }),
  };
  for (const name of VIM_REGISTRY_CALLS)
    Vim[name] = (...args: unknown[]): void => void (defined[name] ??= []).push(args);
  for (const name of VIM_NOOP_CALLS) Vim[name] = (): undefined => undefined;
  return { commands: {}, keyMap: {}, Pos, Vim };
}

export interface LegacyGlobalsOptions {
  /** Resolves the `app` for the code reading the bare global (per-plugin diagnostics proxy). */
  app?: () => unknown;
}

/** Installs the globals on `win`; returns an idempotent uninstaller that restores prior state. */
export function installLegacyGlobals(
  win: Window & typeof globalThis,
  options: LegacyGlobalsOptions = {},
): () => void {
  const target = win as unknown as Record<string, unknown>;
  const ours: [string, PropertyDescriptor][] = [];
  const define = (name: string, descriptor: PropertyDescriptor): void => {
    if (name in target) return; // the page's own global wins
    const full = { configurable: true, enumerable: false, ...descriptor };
    Object.defineProperty(target, name, full);
    ours.push([name, full]);
  };
  define("moment", { value: moment, writable: true });
  define("CodeMirror", { value: createCodeMirror5(), writable: true });
  define("CodeMirrorAdapter", { value: createCodeMirrorAdapter(), writable: true });
  const app = options.app;
  if (app) define("app", { get: app, set: () => {} });
  let done = false;
  return () => {
    if (done) return;
    done = true;
    for (const [name, descriptor] of ours.reverse()) {
      const now = Object.getOwnPropertyDescriptor(target, name);
      // Someone replaced it since: not ours to remove.
      if (!now || now.value !== descriptor.value || now.get !== descriptor.get) continue;
      delete target[name];
    }
  };
}
