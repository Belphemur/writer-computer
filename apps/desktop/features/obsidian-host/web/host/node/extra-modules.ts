// Cheap, safe shims for Node builtins that bundled code requires at load but rarely exercises in a
// WebView: diagnostics_channel, perf_hooks, worker_threads, tty, v8, vm, constants, querystring,
// punycode, domain, timers, timers/promises. Each is either a faithful small implementation or
// inert (no subscribers, nothing spawned); anything that cannot work throws a clear nodeError
// instead of pretending. Everything else Node ships stays an unresolved module on purpose.
import { abortError, nodeError } from "./errors";
import { EventEmitter } from "./events";

type Fn = (...args: any[]) => any;

// ---------------------------------------------------------------- diagnostics_channel

/** A channel nobody can subscribe to: `hasSubscribers` stays false, so publishers skip work. */
export class Channel {
  constructor(readonly name: string | symbol) {}
  get hasSubscribers(): boolean {
    return false;
  }
  subscribe(_onMessage: Fn): void {}
  unsubscribe(_onMessage: Fn): boolean {
    return false;
  }
  publish(_message: unknown): void {}
  bindStore(_store: unknown, _transform?: Fn): void {}
  unbindStore(_store: unknown): boolean {
    return false;
  }
  runStores<R>(_data: unknown, fn: (...a: any[]) => R, thisArg?: unknown, ...args: any[]): R {
    return fn.apply(thisArg, args);
  }
}

const TRACING_EVENTS = ["start", "end", "asyncStart", "asyncEnd", "error"] as const;

class TracingChannel {
  readonly start: Channel;
  readonly end: Channel;
  readonly asyncStart: Channel;
  readonly asyncEnd: Channel;
  readonly error: Channel;
  constructor(nameOrChannels: string | Record<string, Channel>) {
    const pick = (e: (typeof TRACING_EVENTS)[number]): Channel =>
      typeof nameOrChannels === "string"
        ? channel(`tracing:${nameOrChannels}:${e}`)
        : (nameOrChannels[e] ?? new Channel(`tracing:${e}`));
    this.start = pick("start");
    this.end = pick("end");
    this.asyncStart = pick("asyncStart");
    this.asyncEnd = pick("asyncEnd");
    this.error = pick("error");
  }
  get hasSubscribers(): boolean {
    return false;
  }
  subscribe(_handlers: object): void {}
  unsubscribe(_handlers: object): boolean {
    return false;
  }
  traceSync<R>(fn: (...a: any[]) => R, _ctx?: object, thisArg?: unknown, ...args: any[]): R {
    return fn.apply(thisArg, args);
  }
  tracePromise<R>(fn: (...a: any[]) => R, _ctx?: object, thisArg?: unknown, ...args: any[]): R {
    return fn.apply(thisArg, args);
  }
  traceCallback<R>(
    fn: (...a: any[]) => R,
    _pos?: number,
    _ctx?: object,
    thisArg?: unknown,
    ...args: any[]
  ): R {
    return fn.apply(thisArg, args);
  }
}

const channels = new Map<string | symbol, Channel>();
function channel(name: string | symbol): Channel {
  let c = channels.get(name);
  if (!c) channels.set(name, (c = new Channel(name)));
  return c;
}

export const diagnosticsChannelModule = {
  channel,
  hasSubscribers: (_name: string | symbol): boolean => false,
  subscribe: (_name: string | symbol, _onMessage: Fn): void => {},
  unsubscribe: (_name: string | symbol, _onMessage: Fn): boolean => false,
  tracingChannel: (nameOrChannels: string | Record<string, Channel>) =>
    new TracingChannel(nameOrChannels),
  Channel,
};

// ---------------------------------------------------------------- perf_hooks

class InertObserver {
  static readonly supportedEntryTypes: readonly string[] = [];
  constructor(_callback?: Fn) {}
  observe(): void {}
  disconnect(): void {}
  takeRecords(): unknown[] {
    return [];
  }
}

export const perfHooksModule = {
  get performance(): Performance {
    return globalThis.performance;
  },
  PerformanceObserver:
    (globalThis as { PerformanceObserver?: unknown }).PerformanceObserver ?? InertObserver,
  monitorEventLoopDelay: () => ({
    enable: (): boolean => false,
    disable: (): boolean => false,
    reset: (): void => {},
    percentile: (): number => 0,
    min: 0,
    max: 0,
    mean: 0,
    stddev: 0,
  }),
  constants: {},
};

// ---------------------------------------------------------------- worker_threads

class Worker {
  constructor() {
    throw nodeError(
      "ERR_WORKER_UNSUPPORTED",
      "worker_threads.Worker is not supported in Writer: there are no worker threads",
    );
  }
}

export const workerThreadsModule = {
  isMainThread: true,
  isInternalThread: false,
  parentPort: null,
  workerData: null,
  threadId: 0,
  resourceLimits: {},
  SHARE_ENV: Symbol.for("nodejs.worker_threads.SHARE_ENV"),
  Worker,
  MessageChannel: (globalThis as { MessageChannel?: unknown }).MessageChannel,
  MessagePort: (globalThis as { MessagePort?: unknown }).MessagePort,
  BroadcastChannel: (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel,
  markAsUntransferable: (): void => {},
  getEnvironmentData: (): undefined => undefined,
  setEnvironmentData: (): void => {},
};

// ---------------------------------------------------------------- tty

class NoTty {
  constructor() {
    throw nodeError("ERR_TTY_UNSUPPORTED", "tty streams are not supported in Writer");
  }
}
export const ttyModule = {
  isatty: (_fd?: number): boolean => false,
  ReadStream: NoTty,
  WriteStream: NoTty,
};

// ---------------------------------------------------------------- v8

const unsupported = (what: string) => (): never => {
  throw nodeError("ERR_V8_UNSUPPORTED", `${what} is not supported in Writer`);
};
export const v8Module = {
  getHeapStatistics: () => ({
    total_heap_size: 0,
    total_heap_size_executable: 0,
    total_physical_size: 0,
    total_available_size: 0,
    used_heap_size: 0,
    heap_size_limit: 0,
    malloced_memory: 0,
    peak_malloced_memory: 0,
    does_zap_garbage: 0,
    number_of_native_contexts: 0,
    number_of_detached_contexts: 0,
    total_global_handles_size: 0,
    used_global_handles_size: 0,
    external_memory: 0,
  }),
  getHeapSpaceStatistics: (): unknown[] => [],
  setFlagsFromString: (): void => {},
  cachedDataVersionTag: (): number => 0,
  serialize: unsupported("v8.serialize"),
  deserialize: unsupported("v8.deserialize"),
  writeHeapSnapshot: unsupported("v8.writeHeapSnapshot"),
};

// ---------------------------------------------------------------- vm

// Node's vm module is not provided (the CSP now allows 'unsafe-eval', but vm needs sandboxed contexts): say so.
const noVm = (what: string) => (): never => {
  throw nodeError(
    "ERR_VM_UNSUPPORTED",
    `vm.${what}() is not supported in Writer: no code evaluation`,
  );
};
export const vmModule = {
  runInThisContext: noVm("runInThisContext"),
  runInNewContext: noVm("runInNewContext"),
  runInContext: noVm("runInContext"),
  createContext: (o: object = {}): object => o,
  isContext: (_o: unknown): boolean => false,
  compileFunction: noVm("compileFunction"),
  Script: class Script {
    constructor() {
      noVm("Script")();
    }
  },
};

// ---------------------------------------------------------------- constants

export const constantsModule = {
  O_RDONLY: 0,
  O_WRONLY: 1,
  O_RDWR: 2,
  O_CREAT: 64,
  O_EXCL: 128,
  O_TRUNC: 512,
  O_APPEND: 1024,
  S_IFMT: 61440,
  S_IFREG: 32768,
  S_IFDIR: 16384,
  S_IFLNK: 40960,
  F_OK: 0,
  R_OK: 4,
  W_OK: 2,
  X_OK: 1,
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGKILL: 9,
  SIGTERM: 15,
};

// ---------------------------------------------------------------- querystring

const qsEscape = (s: string): string =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
const qsUnescape = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};
const qsPrimitive = (v: unknown): string =>
  typeof v === "string"
    ? v
    : typeof v === "number" && Number.isFinite(v)
      ? String(v)
      : typeof v === "bigint" || typeof v === "boolean"
        ? String(v)
        : "";

export function qsStringify(
  obj: unknown,
  sep = "&",
  eq = "=",
  opts?: { encodeURIComponent?: Fn },
): string {
  if (obj === null || typeof obj !== "object") return "";
  const enc = opts?.encodeURIComponent ?? qsEscape;
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = enc(qsPrimitive(k));
    if (Array.isArray(v)) for (const item of v) out.push(key + eq + enc(qsPrimitive(item)));
    else out.push(key + eq + enc(qsPrimitive(v)));
  }
  return out.join(sep);
}

export function qsParse(
  str: unknown,
  sep = "&",
  eq = "=",
  opts?: { decodeURIComponent?: Fn; maxKeys?: number },
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = Object.create(null);
  if (typeof str !== "string" || str.length === 0) return out;
  const dec = opts?.decodeURIComponent ?? qsUnescape;
  const max = opts?.maxKeys ?? 1000;
  let parts = str.split(sep);
  if (max > 0) parts = parts.slice(0, max);
  for (const part of parts) {
    if (part === "") continue;
    const i = part.indexOf(eq);
    const rawKey = i >= 0 ? part.slice(0, i) : part;
    const rawVal = i >= 0 ? part.slice(i + eq.length) : "";
    const key = dec(rawKey.replace(/\+/g, " "));
    const val = dec(rawVal.replace(/\+/g, " "));
    const cur = out[key];
    if (cur === undefined) out[key] = val;
    else if (Array.isArray(cur)) cur.push(val);
    else out[key] = [cur, val];
  }
  return out;
}

export const querystringModule = {
  stringify: qsStringify,
  parse: qsParse,
  encode: qsStringify,
  decode: qsParse,
  escape: qsEscape,
  unescape: qsUnescape,
};

// ---------------------------------------------------------------- punycode (RFC 3492)

const BASE = 36;
const T_MIN = 1;
const T_MAX = 26;
const SKEW = 38;
const DAMP = 700;
const INITIAL_BIAS = 72;
const INITIAL_N = 128;

const digitToBasic = (d: number): number => d + 22 + 75 * Number(d < 26);
const adapt = (delta: number, numPoints: number, first: boolean): number => {
  let k = 0;
  delta = first ? Math.floor(delta / DAMP) : delta >> 1;
  delta += Math.floor(delta / numPoints);
  for (; delta > ((BASE - T_MIN) * T_MAX) >> 1; k += BASE)
    delta = Math.floor(delta / (BASE - T_MIN));
  return Math.floor(k + ((BASE - T_MIN + 1) * delta) / (delta + SKEW));
};
const ucs2decode = (s: string): number[] => Array.from(s, (c) => c.codePointAt(0) as number);
const ucs2encode = (cps: readonly number[]): string => String.fromCodePoint(...cps);

function punyEncode(input: string): string {
  const cps = ucs2decode(input);
  const out: string[] = cps.filter((c) => c < 0x80).map((c) => String.fromCharCode(c));
  const basic = out.length;
  let handled = basic;
  if (basic) out.push("-");
  let n = INITIAL_N;
  let delta = 0;
  let bias = INITIAL_BIAS;
  while (handled < cps.length) {
    let m = Infinity;
    for (const c of cps) if (c >= n && c < m) m = c;
    delta += (m - n) * (handled + 1);
    n = m;
    for (const c of cps) {
      if (c < n) delta++;
      if (c === n) {
        let q = delta;
        for (let k = BASE; ; k += BASE) {
          const t = k <= bias ? T_MIN : k >= bias + T_MAX ? T_MAX : k - bias;
          if (q < t) break;
          out.push(String.fromCharCode(digitToBasic(t + ((q - t) % (BASE - t)))));
          q = Math.floor((q - t) / (BASE - t));
        }
        out.push(String.fromCharCode(digitToBasic(q)));
        bias = adapt(delta, handled + 1, handled === basic);
        delta = 0;
        handled++;
      }
    }
    delta++;
    n++;
  }
  return out.join("");
}

function punyDecode(input: string): string {
  const out: number[] = [];
  let basic = input.lastIndexOf("-");
  if (basic < 0) basic = 0;
  for (let j = 0; j < basic; j++) {
    if (input.charCodeAt(j) >= 0x80)
      throw nodeError("ERR_PUNYCODE", "Illegal input >= 0x80 (not a basic code point)");
    out.push(input.charCodeAt(j));
  }
  let n = INITIAL_N;
  let i = 0;
  let bias = INITIAL_BIAS;
  for (let idx = basic > 0 ? basic + 1 : 0; idx < input.length;) {
    const oldi = i;
    for (let w = 1, k = BASE; ; k += BASE) {
      if (idx >= input.length) throw nodeError("ERR_PUNYCODE", "Invalid input");
      const c = input.charCodeAt(idx++);
      const digit = c - 48 < 10 ? c - 22 : c - 65 < 26 ? c - 65 : c - 97 < 26 ? c - 97 : BASE;
      if (digit >= BASE) throw nodeError("ERR_PUNYCODE", "Invalid input");
      i += digit * w;
      const t = k <= bias ? T_MIN : k >= bias + T_MAX ? T_MAX : k - bias;
      if (digit < t) break;
      w *= BASE - t;
    }
    bias = adapt(i - oldi, out.length + 1, oldi === 0);
    n += Math.floor(i / (out.length + 1));
    i %= out.length + 1;
    out.splice(i++, 0, n);
  }
  return ucs2encode(out);
}

const mapLabels = (domain: string, fn: (label: string) => string): string => {
  const [local, rest] = domain.includes("@")
    ? [domain.slice(0, domain.indexOf("@") + 1), domain.slice(domain.indexOf("@") + 1)]
    : ["", domain];
  return (
    local +
    rest
      .replace(/[。．｡]/g, ".")
      .split(".")
      .map(fn)
      .join(".")
  );
};

export const punycodeModule = {
  version: "2.1.0",
  ucs2: { decode: ucs2decode, encode: ucs2encode },
  encode: punyEncode,
  decode: punyDecode,
  toASCII: (d: string): string =>
    mapLabels(d, (l) => (/[^\0-\x7F]/.test(l) ? `xn--${punyEncode(l)}` : l)),
  toUnicode: (d: string): string =>
    mapLabels(d, (l) => (l.startsWith("xn--") ? punyDecode(l.slice(4).toLowerCase()) : l)),
};

// ---------------------------------------------------------------- domain (deprecated)

function createDomain() {
  let members: unknown[] = [];
  return Object.assign(new EventEmitter(), {
    run: <R>(fn: (...a: any[]) => R, ...args: any[]): R => fn(...args),
    add: (m: unknown): void => void members.push(m),
    remove: (m: unknown): void => void (members = members.filter((x) => x !== m)),
    bind: <F extends Fn>(fn: F): F => fn,
    intercept: <F extends Fn>(fn: F): F => fn,
    enter: (): void => {},
    exit: (): void => {},
    dispose: (): void => {},
  });
}
export const domainModule = { create: createDomain, active: null };

// ---------------------------------------------------------------- timers, timers/promises

const g = globalThis as unknown as Record<string, Fn>;
const setImmediateShim = (fn: Fn, ...args: unknown[]): unknown => g.setTimeout(fn, 0, ...args);

export const timersModule = {
  setTimeout: (...a: unknown[]) => g.setTimeout(...(a as [Fn])),
  clearTimeout: (t: unknown) => g.clearTimeout(t),
  setInterval: (...a: unknown[]) => g.setInterval(...(a as [Fn])),
  clearInterval: (t: unknown) => g.clearInterval(t),
  setImmediate: (g.setImmediate as Fn | undefined) ?? setImmediateShim,
  clearImmediate: (g.clearImmediate as Fn | undefined) ?? ((t: unknown) => g.clearTimeout(t)),
};

function delayed<T>(ms: number | undefined, value: T, opts?: { signal?: AbortSignal }): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const signal = opts?.signal;
    if (signal?.aborted) return reject(abortError());
    const t = g.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    }, ms ?? 1);
    const onAbort = (): void => {
      g.clearTimeout(t);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export const timersPromisesModule = {
  setTimeout: delayed,
  setImmediate: <T>(value?: T, opts?: { signal?: AbortSignal }): Promise<T | undefined> =>
    delayed(0, value, opts),
  scheduler: {
    wait: (ms: number, opts?: { signal?: AbortSignal }) => delayed(ms, undefined, opts),
    yield: () => delayed(0, undefined),
  },
};
