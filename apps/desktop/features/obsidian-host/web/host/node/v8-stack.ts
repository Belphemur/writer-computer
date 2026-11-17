// V8 stack-trace API for engines without it. Writer's webview on macOS is WebKit (JavaScriptCore),
// which has `Error.captureStackTrace` but ignores `Error.prepareStackTrace`, so `error.stack`
// stays a string. Node-targeted bundles (fastify -> depd, source-map-support, callsites, ...)
// call `captureStackTrace` with a custom `prepareStackTrace` and then `callSite.getFileName()`:
// "getFileName is not a function". This wraps `captureStackTrace` so a custom
// `prepareStackTrace` receives CallSite-like objects parsed from the native string stack.
// A no-op on V8 and idempotent. Only `captureStackTrace` is wrapped; reading `new Error().stack`
// is untouched.

export interface CallSiteLike {
  getFileName(): string | null;
  getLineNumber(): number | null;
  getColumnNumber(): number | null;
  getFunctionName(): string | null;
  getMethodName(): string | null;
  getTypeName(): string | null;
  getThis(): undefined;
  getFunction(): undefined;
  getEvalOrigin(): undefined;
  getScriptNameOrSourceURL(): string | null;
  isNative(): boolean;
  isToplevel(): boolean;
  isEval(): boolean;
  isConstructor(): boolean;
  isAsync(): boolean;
  isPromiseAll(): boolean;
  getPromiseIndex(): null;
  toString(): string;
}

const LOCATION = /^(.*?):(\d+):(\d+)$/;

function callSite(fn: string | null, location: string | null, raw: string): CallSiteLike {
  let file: string | null = null;
  let line: number | null = null;
  let col: number | null = null;
  const native = location === "[native code]";
  if (location && !native) {
    const m = LOCATION.exec(location);
    if (m) {
      file = m[1];
      line = Number(m[2]);
      col = Number(m[3]);
    } else file = location;
  }
  const isConstructor = fn !== null && fn.startsWith("new ");
  const name = fn && fn !== "global code" && fn !== "eval code" ? fn.replace(/^new /, "") : null;
  const dot = name ? name.lastIndexOf(".") : -1;
  return {
    getFileName: () => file,
    getLineNumber: () => line,
    getColumnNumber: () => col,
    getFunctionName: () => name,
    getMethodName: () => (dot >= 0 && name ? name.slice(dot + 1) : null),
    getTypeName: () => (dot >= 0 && name ? name.slice(0, dot) : null),
    getThis: () => undefined,
    getFunction: () => undefined,
    getEvalOrigin: () => undefined,
    getScriptNameOrSourceURL: () => file,
    isNative: () => native,
    isToplevel: () => dot < 0,
    isEval: () => fn === "eval code",
    isConstructor: () => isConstructor,
    isAsync: () => false,
    isPromiseAll: () => false,
    getPromiseIndex: () => null,
    toString: () => raw.trim(),
  };
}

/** Parses a JavaScriptCore (`fn@file:1:2`) or V8-style (`    at fn (file:1:2)`) stack string. */
export function callSitesFromStack(stack: string): CallSiteLike[] {
  const sites: CallSiteLike[] = [];
  for (const raw of stack.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const v8 = /^at (?:(.*?) \()?(.*?)\)?$/.exec(line);
    if (v8) {
      sites.push(callSite(v8[1] ?? null, v8[2], raw));
      continue;
    }
    const at = line.indexOf("@");
    if (at >= 0) sites.push(callSite(at === 0 ? null : line.slice(0, at), line.slice(at + 1), raw));
  }
  return sites;
}

type PrepareFn = (error: object, sites: CallSiteLike[]) => unknown;
interface ErrorCtorLike {
  captureStackTrace?: (target: object, constructorOpt?: unknown) => void;
  prepareStackTrace?: PrepareFn;
}

function hasNativePrepareStackTrace(): boolean {
  const E = Error as unknown as ErrorCtorLike;
  const previous = E.prepareStackTrace;
  let called = false;
  E.prepareStackTrace = () => {
    called = true;
    return "";
  };
  try {
    void new Error().stack;
  } finally {
    E.prepareStackTrace = previous;
  }
  return called;
}

let installed = false;

/** Installs the wrapper on `target` (default: the global `Error`). Returns whether it did. */
export function installV8StackApi(
  target: ErrorCtorLike = Error as unknown as ErrorCtorLike,
  native: boolean = target === (Error as unknown) ? hasNativePrepareStackTrace() : false,
): boolean {
  if (native) return false;
  if (target === (Error as unknown)) {
    if (installed) return false;
    installed = true;
  }
  const original = target.captureStackTrace;
  target.captureStackTrace = function captureStackTrace(obj: object, ctor?: unknown): void {
    original?.call(target, obj, ctor);
    const prepare = target.prepareStackTrace;
    if (typeof prepare !== "function") return;
    const holder = obj as { stack?: unknown };
    const raw = typeof holder.stack === "string" ? holder.stack : (new Error().stack ?? "");
    // Frame 0 is captureStackTrace's caller on V8; JSC's string already starts there.
    holder.stack = prepare(obj, callSitesFromStack(raw));
  };
  return true;
}
