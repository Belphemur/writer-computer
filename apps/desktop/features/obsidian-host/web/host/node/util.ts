// `util`: promisify (with util.promisify.custom), inspect (simple), format, TextEncoder/Decoder,
// types, deprecate, inherits, callbackify.
import { Buffer } from "./buffer";
import { nodeError } from "./errors";

const CUSTOM = Symbol.for("nodejs.util.promisify.custom");

export function promisify(fn: (...args: any[]) => unknown): (...args: any[]) => Promise<unknown> {
  if (typeof fn !== "function")
    throw nodeError("ERR_INVALID_ARG_TYPE", 'The "original" argument must be of type function');
  const custom = (fn as unknown as Record<symbol, unknown>)[CUSTOM];
  if (typeof custom === "function") return custom as (...args: any[]) => Promise<unknown>;
  const wrapped = function (this: unknown, ...args: unknown[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      fn.call(this, ...args, (err: unknown, value: unknown) =>
        err ? reject(err) : resolve(value),
      );
    });
  };
  Object.setPrototypeOf(wrapped, Object.getPrototypeOf(fn));
  Object.defineProperty(wrapped, CUSTOM, { value: wrapped, enumerable: false });
  return Object.defineProperties(wrapped, Object.getOwnPropertyDescriptors(fn));
}
promisify.custom = CUSTOM;

export function callbackify(fn: (...args: any[]) => Promise<unknown>) {
  return function (this: unknown, ...args: any[]): void {
    const cb = args.pop() as (err: unknown, v?: unknown) => void;
    fn.apply(this, args).then(
      (v) => queueMicrotask(() => cb(null, v)),
      (e) => queueMicrotask(() => cb(e ?? new Error("Promise was rejected with a falsy value"))),
    );
  };
}

export function inherits(ctor: any, superCtor: any): void {
  Object.defineProperty(ctor, "super_", { value: superCtor, writable: true, configurable: true });
  Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
}

export const deprecate = <T extends (...a: any[]) => any>(fn: T): T => fn;

// ---------------------------------------------------------------- inspect

export interface InspectOptions {
  depth?: number | null;
  colors?: boolean;
  compact?: boolean | number;
  breakLength?: number;
}

function quote(s: string): string {
  if (!s.includes("'")) return `'${s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n")}'`;
  if (!s.includes('"')) return `"${s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n")}"`;
  return `\`${s.replace(/`/g, "\\`").replace(/\n/g, "\\n")}\``;
}

function inspectValue(v: unknown, depth: number, seen: unknown[], top: boolean): string {
  switch (typeof v) {
    case "string":
      return top ? v : quote(v);
    case "number":
      return Object.is(v, -0) ? "-0" : String(v);
    case "bigint":
      return `${v}n`;
    case "boolean":
    case "undefined":
      return String(v);
    case "symbol":
      return v.toString();
    case "function": {
      const name = (v as { name?: string }).name;
      const isClass = /^class[\s{]/.test(Function.prototype.toString.call(v));
      return `[${isClass ? "class" : "Function"}${name ? `: ${name}` : " (anonymous)"}]`;
    }
  }
  if (v === null) return "null";
  const obj = v as Record<string | symbol, unknown>;
  if (seen.includes(obj)) return "[Circular *1]";
  if (obj instanceof Error) return obj.stack ?? `${obj.name}: ${obj.message}`;
  if (obj instanceof Date) return Number.isNaN(obj.getTime()) ? "Invalid Date" : obj.toISOString();
  if (obj instanceof RegExp) return String(obj);
  if (obj instanceof Promise) return "Promise { <pending> }";
  if (Buffer.isBuffer(obj)) {
    const hex = Array.from(obj.subarray(0, 50), (b) => b.toString(16).padStart(2, "0")).join(" ");
    return `<Buffer${hex ? ` ${hex}` : ""}${obj.length > 50 ? ` ... ${obj.length - 50} more bytes` : ""}>`;
  }
  const ctorName = (obj as { constructor?: { name?: string } }).constructor?.name;
  if (depth < 0) return Array.isArray(obj) ? "[Array]" : `[${ctorName || "Object"}]`;
  const next = [...seen, obj];
  const child = (x: unknown): string => inspectValue(x, depth - 1, next, false);
  let items: string[];
  let open = "{";
  let close = "}";
  let prefix = "";
  if (Array.isArray(obj)) {
    open = "[";
    close = "]";
    items = obj.slice(0, 100).map(child);
    if (obj.length > 100) items.push(`... ${obj.length - 100} more items`);
  } else if (obj instanceof Map) {
    prefix = `Map(${obj.size}) `;
    items = [...obj].map(([k, val]) => `${child(k)} => ${child(val)}`);
  } else if (obj instanceof Set) {
    prefix = `Set(${obj.size}) `;
    items = [...obj].map(child);
  } else {
    if (ArrayBuffer.isView(obj)) {
      prefix = `${ctorName}(${(obj as unknown as Uint8Array).length}) `;
      open = "[";
      close = "]";
      items = Array.from(obj as unknown as ArrayLike<number>)
        .slice(0, 100)
        .map(String);
    } else {
      if (ctorName && ctorName !== "Object") prefix = `${ctorName} `;
      else if (ctorName === undefined) prefix = "[Object: null prototype] ";
      const keys: (string | symbol)[] = [...Object.keys(obj), ...Object.getOwnPropertySymbols(obj)];
      items = keys.map((k) => {
        const key =
          typeof k === "symbol" ? `[${k.toString()}]` : /^[A-Za-z_$][\w$]*$/.test(k) ? k : quote(k);
        return `${key}: ${child(obj[k])}`;
      });
    }
  }
  if (items.length === 0) return `${prefix}${open}${close}`;
  const single = `${prefix}${open} ${items.join(", ")} ${close}`;
  if (single.length <= 72 && !single.includes("\n")) return single;
  const pad = (s: string): string => s.replace(/\n/g, "\n  ");
  return `${prefix}${open}\n  ${items.map(pad).join(",\n  ")}\n${close}`;
}

export function inspect(value: unknown, opts?: InspectOptions | boolean): string {
  const depth =
    typeof opts === "object" && opts && opts.depth !== undefined ? (opts.depth ?? Infinity) : 2;
  return inspectValue(value, depth, [], false);
}
inspect.custom = Symbol.for("nodejs.util.inspect.custom");
inspect.defaultOptions = { depth: 2 };

export function format(fmt?: unknown, ...args: unknown[]): string {
  if (typeof fmt !== "string")
    return [fmt, ...args].map((a) => inspectValue(a, 2, [], true)).join(" ");
  let i = 0;
  let out = fmt.replace(/%[sdifjoO%]/g, (m) => {
    if (m === "%%") return "%";
    if (i >= args.length) return m;
    const a = args[i++];
    switch (m) {
      case "%s":
        return typeof a === "string"
          ? a
          : typeof a === "object" && a !== null
            ? inspect(a, { depth: 0 })
            : String(a);
      case "%d":
        return typeof a === "bigint" ? `${a}n` : String(Number(a));
      case "%i":
        return String(parseInt(String(a), 10));
      case "%f":
        return String(parseFloat(String(a)));
      case "%j":
        try {
          return JSON.stringify(a);
        } catch {
          return "[Circular]";
        }
      default:
        return inspect(a, { depth: m === "%o" ? 4 : 2 });
    }
  });
  for (; i < args.length; i++) out += ` ${inspectValue(args[i], 2, [], true)}`;
  return out;
}

export function isDeepStrictEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (a instanceof Date) return a.getTime() === (b as Date).getTime();
  if (a instanceof Map || a instanceof Set) {
    if (a.size !== (b as Map<unknown, unknown>).size) return false;
    return isDeepStrictEqual([...a], [...(b as Map<unknown, unknown>)]);
  }
  const ka = Reflect.ownKeys(a);
  if (ka.length !== Reflect.ownKeys(b).length) return false;
  return ka.every((k) => isDeepStrictEqual((a as any)[k], (b as any)[k]));
}

export const stripVTControlCharacters = (s: string): string =>
  // oxlint-disable-next-line no-control-regex -- matching ANSI escapes is the point
  s.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");

export const debuglog = (): ((...a: unknown[]) => void) & { enabled: boolean } =>
  Object.assign(() => undefined, { enabled: false });

const tag = (v: unknown): string => Object.prototype.toString.call(v);
export const types = {
  isPromise: (v: unknown): boolean => v instanceof Promise,
  isRegExp: (v: unknown): boolean => v instanceof RegExp,
  isDate: (v: unknown): boolean => v instanceof Date,
  isNativeError: (v: unknown): boolean => v instanceof Error,
  isMap: (v: unknown): boolean => v instanceof Map,
  isSet: (v: unknown): boolean => v instanceof Set,
  isTypedArray: (v: unknown): boolean => ArrayBuffer.isView(v) && !(v instanceof DataView),
  isUint8Array: (v: unknown): boolean => v instanceof Uint8Array,
  isArrayBuffer: (v: unknown): boolean => v instanceof ArrayBuffer,
  isAnyArrayBuffer: (v: unknown): boolean =>
    v instanceof ArrayBuffer ||
    (typeof SharedArrayBuffer !== "undefined" && v instanceof SharedArrayBuffer),
  isArrayBufferView: (v: unknown): boolean => ArrayBuffer.isView(v),
  isAsyncFunction: (v: unknown): boolean => tag(v) === "[object AsyncFunction]",
  isGeneratorFunction: (v: unknown): boolean =>
    /^\[object (Async)?GeneratorFunction\]$/.test(tag(v)),
  isProxy: (): boolean => false,
};

export const utilModule = {
  promisify,
  callbackify,
  inherits,
  deprecate,
  inspect,
  format,
  isDeepStrictEqual,
  stripVTControlCharacters,
  debuglog,
  debug: debuglog,
  types,
  TextEncoder: globalThis.TextEncoder,
  TextDecoder: globalThis.TextDecoder,
  isArray: Array.isArray,
};
