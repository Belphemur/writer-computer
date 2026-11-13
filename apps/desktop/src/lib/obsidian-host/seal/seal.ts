/**
 * Tauri seal: runs once, before the first plugin script is requested.
 *
 * Captures the real `window.__TAURI_INTERNALS__` into a module-private closure and
 * replaces it with a frozen stand-in whose `invoke` only forwards an allowlist of
 * `plugin:*` commands (the ones the app's own dependencies issue through the global:
 * events, window, menu, dialog, opener, clipboard, store). Every other command,
 * including all of Writer's own, is rejected with an explicit Error. Writer's own
 * frontend reaches them through `hostInvoke`, which holds the captured original.
 *
 * Defence in depth, not a sandbox: plugins share the page's realm. See README.md.
 */

interface RealInternals {
  invoke: (cmd: string, args?: unknown, options?: unknown) => Promise<unknown>;
  transformCallback: (cb?: (response: unknown) => void, once?: boolean) => number;
  convertFileSrc: (path: string, protocol?: string) => string;
  metadata?: unknown;
}

interface RealEventInternals {
  unregisterListener: (event: string, eventId: number) => void;
}

export interface SealOptions {
  /** Global object to seal. Defaults to `globalThis`; tests pass a fake. */
  target?: object;
  /** Store file names plugins may open through `plugin:store|load`. */
  allowedStorePaths?: readonly string[];
}

export interface SealResult {
  /** Frozen. Calls the captured real `invoke`, bypassing the guard. Host code only. */
  hostInvoke: HostInvoke;
}

export type HostInvoke = (cmd: string, args?: unknown, options?: unknown) => Promise<unknown>;

export class SealViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SealViolationError";
  }
}

const INTERNALS_KEY = "__TAURI_INTERNALS__";
const EVENT_INTERNALS_KEY = "__TAURI_EVENT_PLUGIN_INTERNALS__";
const GLOBAL_TAURI_KEY = "__TAURI__";

/** Commands the app's own dependencies issue after startup. */
const ALLOWED_COMMANDS: ReadonlySet<string> = new Set([
  "plugin:event|listen",
  "plugin:event|unlisten",
  "plugin:resources|close",
  "plugin:window|show",
  "plugin:window|close",
  "plugin:window|start_dragging",
  "plugin:dialog|open",
  "plugin:dialog|save",
  "plugin:dialog|message",
  "plugin:dialog|ask",
  "plugin:dialog|confirm",
  "plugin:opener|open_url",
  "plugin:opener|open_path",
  "plugin:opener|reveal_item_in_dir",
  "plugin:clipboard-manager|write_text",
  "plugin:clipboard-manager|read_text",
  "plugin:store|load",
  "plugin:store|get_store",
  "plugin:store|get",
  "plugin:store|set",
  "plugin:store|has",
  "plugin:store|delete",
  "plugin:store|keys",
  "plugin:store|values",
  "plugin:store|entries",
  "plugin:store|length",
  "plugin:store|clear",
  "plugin:store|reset",
  "plugin:store|save",
  "plugin:store|reload",
]);

/** Menu API (context menus). Everything except replacing the app/window menu bar. */
const MENU_PREFIX = "plugin:menu|";
const DENIED_MENU_COMMANDS: ReadonlySet<string> = new Set([
  "plugin:menu|set_as_app_menu",
  "plugin:menu|set_as_window_menu",
]);

const SAFE_URL = /^(https?:|mailto:)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function checkArgs(cmd: string, args: unknown, storePaths: readonly string[]): string | null {
  if (cmd === "plugin:store|load" || cmd === "plugin:store|get_store") {
    const path = isRecord(args) ? args.path : undefined;
    if (typeof path !== "string" || !storePaths.includes(path)) {
      return `store path ${JSON.stringify(path)} is not allowed`;
    }
  }
  if (cmd === "plugin:opener|open_url") {
    const url = isRecord(args) ? args.url : undefined;
    if (typeof url !== "string" || !SAFE_URL.test(url)) {
      return "only http(s) and mailto URLs may be opened";
    }
  }
  return null;
}

function deepFreeze<T>(value: T): T {
  if (isRecord(value) && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

function lock(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    writable: false,
    configurable: false,
    enumerable: false,
  });
}

const sealed = new WeakMap<object, SealResult>();
/** Stand-ins we created, so a second call never mistakes one for the real internals. */
const standIns = new WeakSet<object>();
let active: SealResult | null = null;

export function sealTauri(options: SealOptions = {}): SealResult {
  const target = options.target ?? globalThis;
  const existing = sealed.get(target);
  if (existing) return existing;

  const slot = target as Record<string, unknown>;
  const real = slot[INTERNALS_KEY] as RealInternals | undefined;
  if (!real || typeof real.invoke !== "function") {
    throw new SealViolationError("sealTauri: window.__TAURI_INTERNALS__ is missing");
  }
  if (standIns.has(real)) {
    throw new SealViolationError("sealTauri: internals already replaced by an earlier seal");
  }
  const storePaths = Object.freeze([...(options.allowedStorePaths ?? ["preferences.json"])]);

  // Capture everything by reference now; nothing below reads the global again.
  const realInvoke = real.invoke.bind(real);
  const realTransform = real.transformCallback.bind(real);
  const realConvert = real.convertFileSrc.bind(real);
  const metadata = deepFreeze(JSON.parse(JSON.stringify(real.metadata ?? {})) as unknown);
  const realEvents = slot[EVENT_INTERNALS_KEY] as RealEventInternals | undefined;
  const realUnregister = realEvents?.unregisterListener?.bind(realEvents);

  const hostInvoke: HostInvoke = Object.freeze((cmd: string, args?: unknown, opts?: unknown) =>
    realInvoke(cmd, args, opts),
  );

  const guardedInvoke = (cmd: string, args?: unknown, opts?: unknown): Promise<unknown> => {
    if (typeof cmd !== "string") {
      return Promise.reject(new SealViolationError("invoke: command must be a string"));
    }
    const allowed =
      ALLOWED_COMMANDS.has(cmd) || (cmd.startsWith(MENU_PREFIX) && !DENIED_MENU_COMMANDS.has(cmd));
    if (!allowed) {
      return Promise.reject(
        new SealViolationError(`Tauri command "${cmd}" is not available to plugins (sealed)`),
      );
    }
    const reason = checkArgs(cmd, args, storePaths);
    if (reason) {
      return Promise.reject(new SealViolationError(`Tauri command "${cmd}" rejected: ${reason}`));
    }
    return realInvoke(cmd, args, opts);
  };

  const standIn = Object.freeze({
    invoke: guardedInvoke,
    transformCallback: (cb?: (response: unknown) => void, once?: boolean) =>
      realTransform(cb, once),
    convertFileSrc: (path: string, protocol?: string) => realConvert(path, protocol),
    metadata,
    plugins: Object.freeze({}),
  });
  standIns.add(standIn);

  // Install. Any failure leaves the page unsealed, so throw: the loader must not load plugins.
  if (GLOBAL_TAURI_KEY in slot) {
    try {
      delete slot[GLOBAL_TAURI_KEY];
    } catch {
      // handled below
    }
    if (GLOBAL_TAURI_KEY in slot && slot[GLOBAL_TAURI_KEY] !== undefined) {
      lock(target, GLOBAL_TAURI_KEY, undefined);
    }
  }

  lock(target, INTERNALS_KEY, standIn);
  if (realUnregister) {
    lock(
      target,
      EVENT_INTERNALS_KEY,
      Object.freeze({ unregisterListener: (e: string, id: number) => realUnregister(e, id) }),
    );
  }
  const result: SealResult = Object.freeze({ hostInvoke });
  sealed.set(target, result);
  active = result;
  return result;
}

/**
 * Writer's own IPC entry point. Before the seal it forwards to the live global;
 * after the seal it uses the captured original. Never reads the global post-seal.
 */
export const hostInvoke: HostInvoke = (cmd, args, options) => {
  if (active) return active.hostInvoke(cmd, args, options);
  const internals = (globalThis as Record<string, unknown>)[INTERNALS_KEY] as
    | RealInternals
    | undefined;
  if (!internals) return Promise.reject(new Error("Tauri internals are not available"));
  return internals.invoke(cmd, args, options);
};
