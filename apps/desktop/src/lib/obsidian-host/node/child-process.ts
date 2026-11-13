// `child_process` over the `plugin_proc_*` IPC. Real: spawn (ChildProcess with stdin/stdout/stderr
// streams, pid, kill, killed/exitCode/signalCode, 'spawn'/'error'/'exit'/'close', AbortSignal,
// stdio pipe|ignore|inherit(=ignore)), execFile (+ util.promisify.custom), exec/spawn-with-shell
// (refused). Sync variants and fork throw: async IPC cannot block.
//
// Environment: `options.env` REPLACES the child env (Node semantics) and is sent with
// `inherit_env: false`; without `env`, the request carries `inherit_env: true`.
// Identity: the per-plugin `require` knows the plugin id; the global `require` resolves it from
// the call stack (the plugin script's sourceURL is `writer-plugin://localhost/<id>/main.js`).
import { base64ToBytes, bytesToBase64 } from "../api/network";
import { Buffer } from "./buffer";
import { abortError, errnoNumber, messageOf, nodeError, type NodeError } from "./errors";
import { EventEmitter } from "./events";
import type { ProcEvent, ProcSignal, ProcSpawnRequest } from "./ipc";
import { Readable, Writable } from "./stream";
import { getNodeIpc, registerPid, unregisterPid, type PidEntry } from "./state";
import { promisify } from "./util";

const SIGNAL_NUMBERS: Record<number, string> = {
  1: "SIGHUP",
  2: "SIGINT",
  3: "SIGQUIT",
  6: "SIGABRT",
  9: "SIGKILL",
  10: "SIGUSR1",
  12: "SIGUSR2",
  13: "SIGPIPE",
  14: "SIGALRM",
  15: "SIGTERM",
};
const KNOWN_SIGNALS = new Set(Object.values(SIGNAL_NUMBERS));
const SUPPORTED: ReadonlySet<string> = new Set(["SIGTERM", "SIGKILL", "SIGINT", "SIGHUP"]);

/** Plugin id from a stack that contains the plugin script's sourceURL, else `undefined`. */
export function pluginIdFromStack(stack: string | undefined): string | undefined {
  const m = /writer-plugin:\/\/localhost\/([^/\s:)?#]+)\/main\.js/.exec(stack ?? "");
  if (!m) return undefined;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

export type PluginIdSource = string | (() => string | undefined);
export const resolvePluginId = (src: PluginIdSource): string =>
  (typeof src === "string" ? src : src()) || "unknown";

function normalizeSignal(signal: string | number | undefined): string {
  const s = signal === undefined ? "SIGTERM" : signal;
  const name = typeof s === "number" ? SIGNAL_NUMBERS[s] : s;
  if (s === 0) return "0";
  if (!name || !KNOWN_SIGNALS.has(name))
    throw nodeError("ERR_UNKNOWN_SIGNAL", `Unknown signal: ${String(s)}`, { name: "TypeError" });
  return name;
}

export interface SpawnOptions {
  cwd?: string | URL;
  env?: Record<string, string | undefined>;
  stdio?: unknown;
  shell?: unknown;
  signal?: AbortSignal;
  killSignal?: string | number;
  detached?: boolean;
  windowsHide?: boolean;
  [k: string]: unknown;
}

function stdioModes(stdio: unknown): ["pipe" | "ignore", boolean, boolean] {
  const arr: unknown[] =
    stdio === undefined
      ? ["pipe", "pipe", "pipe"]
      : Array.isArray(stdio)
        ? [...stdio]
        : [stdio, stdio, stdio];
  while (arr.length < 3) arr.push("pipe");
  const mode = (v: unknown, name: string): "pipe" | "ignore" => {
    if (v === undefined || v === null || v === "pipe") return "pipe";
    if (v === "ignore" || v === "inherit") return "ignore"; // inherit has no meaning here
    throw nodeError(
      "ERR_UNSUPPORTED_STDIO",
      `child_process: stdio ${name} option ${String(v)} is not supported in Writer`,
    );
  };
  if (arr.length > 3)
    throw nodeError(
      "ERR_UNSUPPORTED_STDIO",
      "child_process: only 3 stdio slots are supported in Writer",
    );
  return [
    mode(arr[0], "stdin"),
    mode(arr[1], "stdout") === "pipe",
    mode(arr[2], "stderr") === "pipe",
  ];
}

const fromBase64 = (b64: string): Buffer => {
  const bytes = base64ToBytes(b64);
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
};

const toCwd = (cwd: unknown): string | undefined => {
  if (cwd === undefined || cwd === null) return undefined;
  if (cwd instanceof URL) return decodeURIComponent(cwd.pathname);
  return String(cwd);
};

export class ChildProcess extends EventEmitter implements PidEntry {
  pid: number | undefined = undefined;
  stdin: Writable | null = null;
  stdout: Readable | null = null;
  stderr: Readable | null = null;
  stdio: [Writable | null, Readable | null, Readable | null] = [null, null, null];
  killed = false;
  exitCode: number | null = null;
  signalCode: string | null = null;
  connected = false;
  spawnfile = "";
  spawnargs: string[] = [];

  private procIdP: Promise<number> | null = null;
  private procId: number | undefined;
  private terminal = false;
  private closeEmitted = false;
  private stdoutOpen = false;
  private stderrOpen = false;
  private abortCleanup: (() => void) | null = null;

  /** A child that never started: emits 'error' then 'close' on the next tick. */
  static failed(err: NodeError, command = ""): ChildProcess {
    const c = new ChildProcess();
    c.spawnfile = command;
    c.terminal = true;
    c.exitCode = typeof err.errno === "number" ? err.errno : -1;
    queueMicrotask(() => {
      c.emit("error", err);
      c.closeEmitted = true;
      c.emit("close", c.exitCode, null);
    });
    return c;
  }

  /** Internal: starts the process. */
  start(command: string, args: string[], options: SpawnOptions, pluginId: string): this {
    const [stdinMode, wantStdout, wantStderr] = stdioModes(options.stdio);
    this.spawnfile = command;
    this.spawnargs = [command, ...args];
    const ipc = getNodeIpc();

    if (stdinMode === "pipe") {
      this.stdin = new Writable({
        write: (chunk, _enc, cb) => {
          if (this.terminal)
            return cb(nodeError("EPIPE", "write EPIPE", { errno: -32, syscall: "write" }));
          this.withProc((id) => ipc.procWrite(id, bytesToBase64(chunk as Uint8Array))).then(
            () => cb(),
            (e) =>
              cb(
                nodeError("EPIPE", `write EPIPE: ${messageOf(e)}`, {
                  errno: -32,
                  syscall: "write",
                }),
              ),
          );
        },
        final: (cb) => {
          if (this.terminal) return cb();
          this.withProc((id) => ipc.procCloseStdin(id)).then(
            () => cb(),
            (e) => cb(nodeError("EPIPE", messageOf(e))),
          );
        },
      });
    }
    if (wantStdout) {
      this.stdout = new Readable();
      this.stdoutOpen = true;
      this.stdout.on("close", () => {
        this.stdoutOpen = false;
        this.maybeClose();
      });
    }
    if (wantStderr) {
      this.stderr = new Readable();
      this.stderrOpen = true;
      this.stderr.on("close", () => {
        this.stderrOpen = false;
        this.maybeClose();
      });
    }
    this.stdio = [this.stdin, this.stdout, this.stderr];

    const request: ProcSpawnRequest = { plugin_id: pluginId, command, stdin: stdinMode };
    if (args.length > 0) request.args = args;
    const cwd = toCwd(options.cwd);
    if (cwd !== undefined) request.cwd = cwd;
    if (options.env) {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(options.env))
        if (v !== undefined && v !== null) env[k] = String(v);
      request.env = env;
      request.inherit_env = false;
    } else request.inherit_env = true;

    const signal = options.signal;
    if (signal) {
      const onAbort = (): void => {
        if (this.kill(options.killSignal ?? "SIGTERM")) this.emit("error", abortError());
      };
      if (signal.aborted) queueMicrotask(onAbort);
      else {
        signal.addEventListener("abort", onAbort, { once: true });
        this.abortCleanup = () => signal.removeEventListener("abort", onAbort);
      }
    }

    try {
      this.procIdP = ipc.procSpawn(request, (ev) => this.onEvent(ev));
    } catch (e) {
      this.procIdP = Promise.reject(e);
    }
    this.procIdP.then(
      (id) => {
        this.procId = id;
      },
      (e: unknown) => {
        const text = messageOf(e);
        const code = /^(ENOENT|EACCES|EPERM)/.exec(text)?.[1] ?? "UNKNOWN";
        this.onEvent({ type: "error", code, message: text });
      },
    );
    return this;
  }

  private withProc<T>(fn: (id: number) => Promise<T>): Promise<T> {
    if (this.procId !== undefined) return fn(this.procId);
    return this.procIdP!.then(fn);
  }

  private onEvent(ev: ProcEvent): void {
    switch (ev.type) {
      case "spawn":
        this.pid = ev.pid;
        registerPid(ev.pid, this);
        this.emit("spawn");
        return;
      case "stdout":
        this.stdout?.push(fromBase64(ev.data_base64));
        return;
      case "stderr":
        this.stderr?.push(fromBase64(ev.data_base64));
        return;
      case "exit":
        if (this.terminal) return;
        this.finish();
        this.exitCode = ev.code;
        this.signalCode = ev.signal;
        this.emit("exit", ev.code, ev.signal);
        this.maybeClose();
        return;
      case "error": {
        if (this.terminal) return;
        this.finish();
        const err = nodeError(ev.code, `spawn ${this.spawnfile} ${ev.code}`, {
          errno: errnoNumber(ev.code),
          syscall: `spawn ${this.spawnfile}`,
          path: this.spawnfile,
          spawnargs: this.spawnargs.slice(1),
          detail: ev.message,
        });
        this.exitCode = err.errno as number;
        this.emit("error", err);
        this.maybeClose();
      }
    }
  }

  /** Terminal bookkeeping shared by exit and error. */
  private finish(): void {
    this.terminal = true;
    this.abortCleanup?.();
    this.abortCleanup = null;
    if (this.pid !== undefined) unregisterPid(this.pid, this);
    this.stdout?.push(null);
    this.stderr?.push(null);
    this.stdin?.destroy();
    // Like Node's flushStdio: nobody reads an untouched stream, so let it drain and close.
    queueMicrotask(() => {
      for (const s of [this.stdout, this.stderr])
        if (
          s &&
          s.readableFlowing === null &&
          s.listenerCount("data") === 0 &&
          s.listenerCount("readable") === 0
        )
          s.resume();
    });
  }

  private maybeClose(): void {
    if (this.closeEmitted || !this.terminal || this.stdoutOpen || this.stderrOpen) return;
    this.closeEmitted = true;
    queueMicrotask(() => this.emit("close", this.exitCode, this.signalCode));
  }

  kill(signal?: string | number): boolean {
    return this.killProc(signal ?? "SIGTERM", true);
  }

  /** Shared by kill() and process.kill(). Returns false once the child is gone. */
  killProc(signal: string | number, group: boolean): boolean {
    const name = normalizeSignal(signal);
    if (this.terminal || !this.procIdP) return false;
    if (name === "0") return true;
    if (!SUPPORTED.has(name))
      throw nodeError(
        "ERR_SIGNAL_UNSUPPORTED",
        `Signal ${name} is not supported in Writer (use SIGTERM, SIGKILL, SIGINT or SIGHUP)`,
      );
    this.killed = true;
    const ipc = getNodeIpc();
    this.withProc((id) => ipc.procKill(id, name as ProcSignal, group)).catch(() => {
      // The process may already be gone; the terminal event reports the outcome.
    });
    return true;
  }

  ref(): void {}
  unref(): void {}
  disconnect(): void {}
  send(): boolean {
    throw nodeError(
      "ERR_IPC_UNSUPPORTED",
      "child_process IPC channels are not supported in Writer",
    );
  }
}

// ---------------------------------------------------------------- spawn / execFile

type ArgsOrOptions = readonly string[] | SpawnOptions | undefined | null;

function splitArgs(
  a: ArgsOrOptions,
  b?: SpawnOptions | null,
): { args: string[]; options: SpawnOptions } {
  if (Array.isArray(a)) return { args: a.map(String), options: b ?? {} };
  return { args: [], options: (a as SpawnOptions | undefined | null) ?? b ?? {} };
}

const shellUnsupported = (api: string): NodeError =>
  nodeError(
    "ERR_SHELL_UNSUPPORTED",
    `child_process.${api}: shell execution is not supported in Writer; spawn the executable directly with an args array`,
  );

export interface ChildProcessModuleOptions {
  /** Per-plugin id, or a resolver (global require: from the call stack). */
  pluginId: PluginIdSource;
}

export function createChildProcessModule(opts: ChildProcessModuleOptions) {
  const idNow = (): string => resolvePluginId(opts.pluginId);

  function spawn(
    command: string,
    argsOrOptions?: ArgsOrOptions,
    maybeOptions?: SpawnOptions,
  ): ChildProcess {
    if (typeof command !== "string" || command === "")
      throw nodeError("ERR_INVALID_ARG_TYPE", 'The "file" argument must be of type string', {
        name: "TypeError",
      });
    const { args, options } = splitArgs(argsOrOptions, maybeOptions);
    if (options.shell) throw shellUnsupported("spawn");
    return new ChildProcess().start(command, args, options, idNow());
  }

  interface ExecOptions extends SpawnOptions {
    encoding?: string | null;
    timeout?: number;
    maxBuffer?: number;
  }
  type ExecCb = (err: NodeError | null, stdout?: string | Buffer, stderr?: string | Buffer) => void;

  function execFile(file: string, ...rest: unknown[]): ChildProcess {
    let cb: ExecCb | undefined;
    if (typeof rest[rest.length - 1] === "function") cb = rest.pop() as ExecCb;
    const { args, options } = splitArgs(
      rest[0] as ArgsOrOptions,
      rest[1] as ExecOptions | undefined,
    );
    const o = options as ExecOptions;
    if (o.shell) throw shellUnsupported("execFile");
    const encoding = o.encoding === undefined ? "utf8" : o.encoding;
    const maxBuffer = o.maxBuffer ?? 1024 * 1024;
    const killSignal = o.killSignal ?? "SIGTERM";
    const child = spawn(file, args, { ...o, shell: undefined });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let outLen = 0;
    let errLen = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let failure: NodeError | null = null;
    const cmd = [file, ...args].join(" ");

    const render = (chunks: Buffer[]): string | Buffer => {
      const all = Buffer.concat(chunks);
      return encoding === null || encoding === "buffer" ? all : all.toString(encoding);
    };
    const settle = (err: NodeError | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const stdout = render(outChunks);
      const stderr = render(errChunks);
      if (err) {
        err.cmd = cmd;
        err.stdout = stdout;
        err.stderr = stderr;
      }
      cb?.(err, stdout, stderr);
    };
    const overflow = (which: "stdout" | "stderr"): void => {
      if (failure) return;
      failure = nodeError(
        "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
        `${which} maxBuffer length exceeded`,
      );
      child.kill(killSignal);
    };
    child.stdout?.on("data", (c: Buffer) => {
      outLen += c.length;
      if (outLen > maxBuffer) {
        outChunks.push(c.subarray(0, Math.max(0, c.length - (outLen - maxBuffer))));
        overflow("stdout");
      } else outChunks.push(c);
    });
    child.stderr?.on("data", (c: Buffer) => {
      errLen += c.length;
      if (errLen > maxBuffer) {
        errChunks.push(c.subarray(0, Math.max(0, c.length - (errLen - maxBuffer))));
        overflow("stderr");
      } else errChunks.push(c);
    });
    if (o.timeout && o.timeout > 0) {
      timer = setTimeout(() => void child.kill(killSignal), o.timeout);
    }
    child.on("error", (e: NodeError) => settle(e));
    child.on("close", (code: number | null, signal: string | null) => {
      if (code === 0 && signal === null && !failure) return settle(null);
      let err = failure;
      if (!err) {
        err = new Error(`Command failed: ${cmd}\n${render(errChunks)}`) as NodeError;
        err.code = code as unknown as string; // numeric exit code (null when signalled), like Node
      }
      err.killed = child.killed;
      err.signal = signal;
      settle(err);
    });
    return child;
  }
  (execFile as unknown as Record<symbol, unknown>)[promisify.custom] = (
    file: string,
    ...rest: unknown[]
  ) => {
    let child: ChildProcess | undefined;
    const p = new Promise((resolve, reject) => {
      child = execFile(file, ...rest, ((err: NodeError | null, stdout: unknown, stderr: unknown) =>
        err ? reject(err) : resolve({ stdout, stderr })) as ExecCb);
    });
    return Object.assign(p, { child });
  };

  function exec(command: string, ...rest: unknown[]): ChildProcess {
    const cb = rest.find((r) => typeof r === "function") as ExecCb | undefined;
    const err = shellUnsupported("exec");
    const child = ChildProcess.failed(err, command);
    child.on("error", () => {});
    if (cb) queueMicrotask(() => cb(err, "", ""));
    return child;
  }
  (exec as unknown as Record<symbol, unknown>)[promisify.custom] = () =>
    Promise.reject(shellUnsupported("exec"));

  const unsupportedSync = (name: string) => (): never => {
    throw nodeError(
      "ERR_SYNC_UNSUPPORTED",
      `child_process.${name}() is not supported in this host: process IPC is asynchronous. Use the async API.`,
    );
  };

  return {
    ChildProcess,
    spawn,
    execFile,
    exec,
    fork: unsupportedSync("fork"),
    spawnSync: unsupportedSync("spawnSync"),
    execSync: unsupportedSync("execSync"),
    execFileSync: unsupportedSync("execFileSync"),
  };
}
