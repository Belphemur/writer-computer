// `process`: one shared object, seeded from the os snapshot (platform/arch/env incl. the login
// PATH, cwd() = vault base). Deliberately NOT Node: no `versions.node`, `browser: true`.
// Signal/exit/listener APIs are inert (`process.on('exit'|signals)` handlers NEVER fire: Rust
// kills children when the window closes; `emitWarning` is a silent no-op); `kill(pid, sig)` routes to plugin_proc_kill through the pid
// table filled by child_process (negative pid = process group).
import { bytesToBinaryString } from "./buffer";
import { getBasePath, getOsInfo, lookupPid } from "./state";

type Fn = (...args: any[]) => any;

const SIGNALS: Record<number, string> = { 1: "SIGHUP", 2: "SIGINT", 9: "SIGKILL", 15: "SIGTERM" };

export const EXEC_PATH = "writer";

function writeStub(fd: number) {
  const self: Record<string, unknown> = {
    fd,
    isTTY: false,
    writable: true,
    write(chunk: unknown, enc?: unknown, cb?: unknown): boolean {
      void (chunk instanceof Uint8Array ? bytesToBinaryString(chunk) : chunk);
      const done = typeof enc === "function" ? enc : cb;
      if (typeof done === "function") queueMicrotask(() => (done as Fn)());
      return true;
    },
    end: () => self,
  };
  for (const n of ["on", "once", "off", "addListener", "removeListener", "removeAllListeners"])
    self[n] = () => self;
  return self;
}

function stdinStub() {
  const self: Record<string, unknown> = { fd: 0, readable: false };
  for (const n of [
    "on",
    "once",
    "off",
    "addListener",
    "removeListener",
    "resume",
    "pause",
    "setEncoding",
    "setRawMode",
    "unref",
    "ref",
  ])
    self[n] = () => self;
  return self;
}

function killProcess(pid: number, signal: string | number = "SIGTERM"): true {
  if (typeof pid !== "number" || !Number.isInteger(pid)) {
    const e = new TypeError(`The "pid" argument must be of type number. Received ${String(pid)}`);
    (e as TypeError & { code: string }).code = "ERR_INVALID_ARG_TYPE";
    throw e;
  }
  const group = pid < 0;
  const entry = lookupPid(Math.abs(pid));
  if (!entry)
    throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH", errno: -3, syscall: "kill" });
  const name = typeof signal === "number" ? SIGNALS[signal] : signal;
  if (signal === 0 || name === undefined) {
    if (signal === 0) return true; // existence probe
    throw Object.assign(new TypeError(`Unknown signal: ${String(signal)}`), {
      code: "ERR_UNKNOWN_SIGNAL",
    });
  }
  entry.killProc(name, group);
  return true;
}

export type ProcessShim = Record<string, any>;

export function createProcessShim(): ProcessShim {
  const start = typeof performance !== "undefined" ? performance.now() : 0;
  const hrtime = Object.assign(
    (prev?: [number, number]): [number, number] => {
      const ms = typeof performance !== "undefined" ? performance.now() : Date.now();
      let s = Math.floor(ms / 1000);
      let ns = Math.floor((ms % 1000) * 1e6);
      if (prev) {
        s -= prev[0];
        ns -= prev[1];
        if (ns < 0) {
          s--;
          ns += 1e9;
        }
      }
      return [s, ns];
    },
    {
      bigint: (): bigint =>
        BigInt(
          Math.floor((typeof performance !== "undefined" ? performance.now() : Date.now()) * 1e6),
        ),
    },
  );
  const self: ProcessShim = {
    argv: [EXEC_PATH],
    execArgv: [],
    execPath: EXEC_PATH,
    title: "writer",
    version: "v0.0.0",
    // No `versions.node`: plugins use it to detect a real Node, which this is not.
    versions: {},
    pid: 1,
    ppid: 0,
    exitCode: undefined,
    browser: true,
    release: { name: "writer" },
    config: {},
    features: {},
    cwd: (): string => getBasePath(),
    chdir: (): never => {
      throw new Error("process.chdir() is not supported in Writer");
    },
    umask: (): number => 0o22,
    uptime: (): number =>
      ((typeof performance !== "undefined" ? performance.now() : 0) - start) / 1000,
    memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }),
    nextTick: (cb: Fn, ...args: unknown[]): void => {
      queueMicrotask(() => cb(...args));
    },
    hrtime,
    emitWarning: (): void => {},
    exit: (): void => {},
    abort: (): void => {},
    kill: killProcess,
    on: () => self,
    once: () => self,
    off: () => self,
    addListener: () => self,
    removeListener: () => self,
    removeAllListeners: () => self,
    prependListener: () => self,
    prependOnceListener: () => self,
    setMaxListeners: () => self,
    getMaxListeners: (): number => 10,
    emit: (): boolean => false,
    listeners: (): Fn[] => [],
    listenerCount: (): number => 0,
    eventNames: (): string[] => [],
    stdout: writeStub(1),
    stderr: writeStub(2),
    stdin: stdinStub(),
  };
  applyOsInfo(self);
  return self;
}

/** (Re)seeds platform/arch/env from the os snapshot. Keeps the `env` object identity. */
export function applyOsInfo(proc: ProcessShim): void {
  const info = getOsInfo();
  proc.platform = info.platform;
  proc.arch = info.arch;
  const env: Record<string, string> = (proc.env as Record<string, string> | undefined) ?? {};
  for (const k of Object.keys(env)) delete env[k];
  Object.assign(env, info.env);
  proc.env = env;
}

let shared: ProcessShim | null = null;
/** The one `process` every plugin (and the global) sees. */
export function getSharedProcess(): ProcessShim {
  return (shared ??= createProcessShim());
}
