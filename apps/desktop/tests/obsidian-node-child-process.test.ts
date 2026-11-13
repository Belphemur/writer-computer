import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { Buffer } from "../src/lib/obsidian-host/node/buffer";
import {
  createChildProcessModule,
  pluginIdFromStack,
} from "../src/lib/obsidian-host/node/child-process";
import { createProcessShim } from "../src/lib/obsidian-host/node/process";
import { createInterface } from "../src/lib/obsidian-host/node/readline";
import { resetNodeRuntimeForTests, setNodeIpc } from "../src/lib/obsidian-host/node/state";
import { FakeNodeIpc, flush } from "../src/lib/obsidian-host/node/testing";
import { promisify } from "../src/lib/obsidian-host/node/util";

let ipc: FakeNodeIpc;
beforeEach(() => {
  resetNodeRuntimeForTests();
  ipc = new FakeNodeIpc();
  setNodeIpc(ipc);
});
afterEach(() => resetNodeRuntimeForTests());

const cp = () => createChildProcessModule({ pluginId: "p1" });
type Err = Error & {
  code?: string | number | null;
  killed?: boolean;
  signal?: string | null;
  stdout?: unknown;
  stderr?: unknown;
  cmd?: string;
};

describe("spawn lifecycle", () => {
  it("builds the wire request and emits spawn, data, exit, close in order", async () => {
    const { spawn } = cp();
    ipc.onSpawn = (p) => {
      p.stdout("hello ");
      p.stdout("world");
      p.stderr("warn");
      p.exit(0);
    };
    const child = spawn("claude", ["--version"], {
      cwd: "/vault",
      env: { A: "1", B: undefined },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: true,
    });
    expect(child.pid).toBeUndefined();
    const events: string[] = [];
    let out = "";
    child.on("spawn", () => events.push("spawn"));
    child.stdout!.on("data", (c: Buffer) => {
      expect(Buffer.isBuffer(c)).toBe(true);
      out += c.toString();
    });
    child.stdout!.on("end", () => events.push("stdout-end"));
    child.on("exit", (code: number, sig: string | null) => events.push(`exit:${code}:${sig}`));
    child.on("close", (code: number) => events.push(`close:${code}`));
    await flush();
    expect(events).toEqual(["spawn", "exit:0:null", "stdout-end", "close:0"]);
    expect(out).toBe("hello world");
    expect(child.pid).toBe(4001);
    expect(child.exitCode).toBe(0);
    expect(child.signalCode).toBeNull();
    expect(child.killed).toBe(false);
    expect(ipc.procs[0].request).toEqual({
      plugin_id: "p1",
      command: "claude",
      args: ["--version"],
      cwd: "/vault",
      env: { A: "1" },
      inherit_env: false,
      stdin: "pipe",
    });
  });

  it("without env it inherits the app environment; cwd and args are omitted when absent", async () => {
    const { spawn } = cp();
    spawn("tool");
    await flush();
    expect(ipc.procs[0].request).toEqual({
      plugin_id: "p1",
      command: "tool",
      inherit_env: true,
      stdin: "pipe",
    });
  });

  it("tolerates events delivered before the spawn invoke resolves", async () => {
    ipc.eventsBeforeResolve = true;
    ipc.onSpawn = (p) => {
      p.stdout("early\n");
      p.exit(0);
    };
    const child = cp().spawn("x");
    let data = "";
    child.stdout!.on("data", (c: Buffer) => (data += c.toString()));
    const closed = new Promise((r) => child.on("close", r));
    await closed;
    expect(data).toBe("early\n");
  });

  it("drains stdout/stderr before 'close', even when exit follows the last chunk immediately", async () => {
    const { spawn } = cp();
    ipc.onSpawn = (p) => {
      for (let i = 0; i < 50; i++) p.stdout(`line ${i}\n`);
      p.stderr("tail");
      p.exit(3);
    };
    const child = spawn("x");
    const order: string[] = [];
    let lines = 0;
    child.stdout!.on("data", (c: Buffer) => (lines += c.toString().split("\n").length - 1));
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (s: string) => order.push(`stderr:${s}`));
    child.on("close", (code: number) => order.push(`close:${code}:lines=${lines}`));
    await flush();
    expect(order).toEqual(["stderr:tail", "close:3:lines=50"]);
  });

  it("closes even if nobody ever reads stdout/stderr", async () => {
    const child = cp().spawn("x");
    ipc.onSpawn = (p) => {
      p.stdout("ignored");
      p.exit(0);
    };
    const closed = new Promise<number>((r) => child.on("close", r));
    expect(await closed).toBe(0);
  });

  it("handles stdio modes: ignore/inherit become 'ignore'; null streams; unsupported modes throw", async () => {
    const { spawn } = cp();
    const a = spawn("x", [], { stdio: ["ignore", "ignore", "inherit"] });
    expect(a.stdin).toBeNull();
    expect(a.stdout).toBeNull();
    expect(a.stderr).toBeNull();
    const b = spawn("x", { stdio: "inherit" });
    expect(b.stdin).toBeNull();
    await flush();
    expect(ipc.procs[0].request.stdin).toBe("ignore");
    expect(() => spawn("x", [], { stdio: [0, 1, 2] })).toThrow(/not supported/);
    expect(() => spawn("x", [], { stdio: ["pipe", "pipe", "pipe", "ipc"] })).toThrow(/3 stdio/);
    const closed = new Promise((r) => a.on("close", r));
    ipc.procs[0].exit(0);
    await closed; // closes with no stdio streams at all
  });

  it("rejects shell mode and bad commands up front", () => {
    const { spawn } = cp();
    expect(() => spawn("ls", { shell: true })).toThrow(/shell execution is not supported/);
    expect(() => spawn("")).toThrow(/must be of type string/);
  });
});

describe("spawn stdin", () => {
  it("writes arrive in order as base64, end() closes stdin once, writableEnded is immediate", async () => {
    const child = cp().spawn("cat");
    expect(child.stdin!.write("one\n")).toBe(true);
    child.stdin!.write(Buffer.from("two\n"));
    child.stdin!.end('{"x":"é"}\n');
    expect(child.stdin!.writableEnded).toBe(true);
    await flush(5);
    expect(ipc.procs[0].stdinWrites).toEqual(["one\n", "two\n", '{"x":"é"}\n']);
    expect(ipc.procs[0].stdinClosed).toBe(true);
  });

  it("a write after the process exited errors with EPIPE (callback), never hangs", async () => {
    const child = cp().spawn("x");
    ipc.onSpawn = (p) => p.exit(0);
    await new Promise((r) => child.on("close", r));
    child.stdin!.on("error", () => {});
    const err = await new Promise<Err | null | undefined>((res) => child.stdin!.write("late", res));
    expect(err?.code).toMatch(/EPIPE|ERR_STREAM_DESTROYED/);
    expect(child.stdin!.destroyed).toBe(true);
  });

  it("a failed IPC write surfaces as an 'error' event on stdin", async () => {
    const child = cp().spawn("x");
    ipc.procWrite = async () => {
      throw new Error("channel gone");
    };
    const err = new Promise<Err>((r) => child.stdin!.on("error", r as never));
    child.stdin!.write("a");
    expect((await err).code).toBe("EPIPE");
  });
});

describe("spawn failures", () => {
  it("ENOENT error event: error then close(-2), no exit; code/syscall/path set", async () => {
    const { spawn } = cp();
    ipc.onSpawn = (p) => p.error("ENOENT", "No such file or directory");
    const child = spawn("nope", ["a", "b"]);
    const events: string[] = [];
    child.on("error", (e: Err & { path?: string; syscall?: string; spawnargs?: string[] }) => {
      events.push(`error:${e.code}:${e.syscall}:${e.path}:${String(e.spawnargs)}`);
    });
    child.on("exit", () => events.push("exit"));
    child.on("close", (code: number) => events.push(`close:${code}`));
    await flush();
    expect(events).toEqual(["error:ENOENT:spawn nope:nope:a,b", "close:-2"]);
    expect(child.exitCode).toBe(-2);
    expect(child.kill()).toBe(false);
  });

  it("consent denial (invoke rejects with EACCES...) becomes an EACCES error event", async () => {
    ipc.spawnRejection = "EACCES: spawn not permitted for plugin p1";
    const child = cp().spawn("claude");
    const err = await new Promise<Err>((r) => child.on("error", r as never));
    expect(err.code).toBe("EACCES");
    expect(err.message).toMatch(/spawn claude EACCES/);
    // stdin is torn down; a write rejects instead of hanging
    child.stdin?.on("error", () => {});
    const closed = await new Promise<number>((r) => child.on("close", r));
    expect(closed).toBeLessThan(0);
  });

  it("an unknown rejection maps to UNKNOWN; only one terminal event is honoured", async () => {
    ipc.spawnRejection = "boom";
    const child = cp().spawn("x");
    const codes: unknown[] = [];
    child.on("error", (e: Err) => codes.push(e.code));
    await flush();
    expect(codes).toEqual(["UNKNOWN"]);
  });
});

describe("kill / signals / abort", () => {
  it("kill(SIGTERM) sends the signal as a group kill; the exit event reports the signal", async () => {
    const child = cp().spawn("sleep");
    await flush();
    expect(child.kill("SIGTERM")).toBe(true);
    expect(child.killed).toBe(true);
    await flush();
    expect(ipc.procs[0].kills).toEqual([{ signal: "SIGTERM", group: true }]);
    const exit = new Promise<[number | null, string | null]>((r) =>
      child.on("exit", (c: number | null, s: string | null) => r([c, s])),
    );
    ipc.procs[0].exit(null, "SIGTERM");
    expect(await exit).toEqual([null, "SIGTERM"]);
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBe("SIGTERM");
    expect(child.kill("SIGKILL")).toBe(false); // already gone
  });

  it("kill() before the proc id is known is delivered once spawn resolves; default SIGTERM; numbers map", async () => {
    const child = cp().spawn("x");
    expect(child.kill()).toBe(true);
    expect(child.kill(9)).toBe(true);
    await flush();
    expect(ipc.procs[0].kills).toEqual([
      { signal: "SIGTERM", group: true },
      { signal: "SIGKILL", group: true },
    ]);
  });

  it("rejects unknown and unsupported signals; sig 0 is an existence probe", async () => {
    const child = cp().spawn("x");
    await flush();
    expect(() => child.kill("SIGNOPE")).toThrow(/Unknown signal/);
    expect(() => child.kill("SIGUSR1")).toThrow(/not supported/);
    expect(child.kill(0)).toBe(true);
    expect(child.killed).toBe(false);
    expect(ipc.procs[0].kills).toEqual([]);
  });

  it("AbortSignal kills the child and emits an AbortError", async () => {
    const ac = new AbortController();
    const child = cp().spawn("x", [], { signal: ac.signal });
    await flush();
    const err = new Promise<Err>((r) => child.on("error", r as never));
    ac.abort();
    const e = await err;
    expect(e.name).toBe("AbortError");
    expect(e.code).toBe("ABORT_ERR");
    await flush();
    expect(ipc.procs[0].kills).toEqual([{ signal: "SIGTERM", group: true }]);
    expect(child.killed).toBe(true);
  });

  it("an already-aborted signal kills right after spawn", async () => {
    const ac = new AbortController();
    ac.abort();
    const child = cp().spawn("x", [], { signal: ac.signal, killSignal: "SIGKILL" });
    child.on("error", () => {});
    await flush();
    expect(ipc.procs[0].kills).toEqual([{ signal: "SIGKILL", group: true }]);
  });

  it("an abort after exit does nothing", async () => {
    const ac = new AbortController();
    const child = cp().spawn("x", [], { signal: ac.signal });
    await flush();
    ipc.procs[0].exit(0);
    await new Promise((r) => child.on("close", r));
    ac.abort();
    await flush();
    expect(ipc.procs[0].kills).toEqual([]);
  });
});

describe("process.kill via the pid table", () => {
  it("negative pid = group kill, positive = single; unknown pid throws ESRCH; clears after exit", async () => {
    const child = cp().spawn("x");
    await flush();
    const proc = createProcessShim();
    expect(proc.kill(-child.pid!, "SIGTERM")).toBe(true);
    expect(proc.kill(child.pid!, 9)).toBe(true);
    expect(proc.kill(child.pid!, 0)).toBe(true);
    await flush();
    expect(ipc.procs[0].kills).toEqual([
      { signal: "SIGTERM", group: true },
      { signal: "SIGKILL", group: false },
    ]);
    ipc.procs[0].exit(null, "SIGKILL");
    await new Promise((r) => child.on("close", r));
    expect(() => proc.kill(child.pid!)).toThrow(/ESRCH/);
  });
});

describe("readline over child stdout (SDK shape)", () => {
  it("for-await over stdout lines, stdin round trip, then kill", async () => {
    const { spawn } = cp();
    ipc.onSpawn = (p) => {
      p.onStdin = (text) => {
        const reply = `${JSON.stringify({ echo: JSON.parse(text) })}\n`;
        const mid = Math.floor(reply.length / 2);
        p.stdout(reply.slice(0, mid)); // split mid-line on purpose
        p.stdout(reply.slice(mid));
      };
    };
    const child = spawn("claude", ["--input-format", "stream-json"]);
    const rl = createInterface({ input: child.stdout! });
    child.stdin!.write(`${JSON.stringify({ n: 1 })}\n`);
    child.stdin!.write(`${JSON.stringify({ n: 2 })}\n`);
    const got: unknown[] = [];
    for await (const line of rl) {
      got.push(JSON.parse(line));
      if (got.length === 2) break;
    }
    expect(got).toEqual([{ echo: { n: 1 } }, { echo: { n: 2 } }]);
    child.kill("SIGTERM");
    await flush();
    ipc.procs[0].exit(null, "SIGTERM");
    await new Promise((r) => child.on("close", r));
    expect(ipc.procs[0].kills[0].signal).toBe("SIGTERM");
  });
});

describe("execFile", () => {
  it("callback form returns stdout/stderr strings by default", async () => {
    const { execFile } = cp();
    ipc.onSpawn = (p) => {
      p.stdout("1.2.3\n");
      p.stderr("note");
      p.exit(0);
    };
    const [err, stdout, stderr] = await new Promise<unknown[]>((res) =>
      execFile("claude", ["--version"], { env: { A: "b" } }, (...a: unknown[]) => res(a)),
    );
    expect(err).toBeNull();
    expect(stdout).toBe("1.2.3\n");
    expect(stderr).toBe("note");
    expect(ipc.procs[0].request.args).toEqual(["--version"]);
  });

  it("options may be omitted, args may be omitted, encoding 'buffer' returns Buffers", async () => {
    const { execFile } = cp();
    ipc.onSpawn = (p) => {
      p.stdout("x");
      p.exit(0);
    };
    const [, out] = await new Promise<unknown[]>((res) =>
      execFile("t", { encoding: "buffer" }, (...a: unknown[]) => res(a)),
    );
    expect(Buffer.isBuffer(out)).toBe(true);
    const [, out2] = await new Promise<unknown[]>((res) =>
      execFile("t", (...a: unknown[]) => res(a)),
    );
    expect(out2).toBe("x");
  });

  it("util.promisify resolves {stdout, stderr}", async () => {
    const { execFile } = cp();
    ipc.onSpawn = (p) => {
      p.stdout("ok");
      p.exit(0);
    };
    const run = promisify(execFile as never) as (
      ...a: unknown[]
    ) => Promise<{ stdout: string; stderr: string }>;
    expect(await run("which", ["claude"], { timeout: 5000 })).toEqual({ stdout: "ok", stderr: "" });
  });

  it("a non-zero exit rejects with code, stdout, stderr, killed=false, signal=null", async () => {
    const { execFile } = cp();
    ipc.onSpawn = (p) => {
      p.stdout('{"loggedIn":false}');
      p.stderr("not logged in");
      p.exit(1);
    };
    const run = promisify(execFile as never) as (...a: unknown[]) => Promise<unknown>;
    const err = (await run("claude", ["auth", "status"]).catch((e: Err) => e)) as Err;
    expect(err.code).toBe(1);
    expect(err.stdout).toBe('{"loggedIn":false}');
    expect(err.stderr).toBe("not logged in");
    expect(err.killed).toBe(false);
    expect(err.signal).toBeNull();
    expect(err.cmd).toBe("claude auth status");
    expect(err.message).toMatch(/^Command failed: claude auth status/);
  });

  it("ENOENT rejects with code 'ENOENT'", async () => {
    const { execFile } = cp();
    ipc.onSpawn = (p) => p.error("ENOENT");
    const run = promisify(execFile as never) as (...a: unknown[]) => Promise<unknown>;
    const err = (await run("nothing").catch((e: Err) => e)) as Err;
    expect(err.code).toBe("ENOENT");
    expect(err.stdout).toBe("");
  });

  it("timeout kills with killSignal and reports killed + signal", async () => {
    const { execFile } = cp();
    ipc.onSpawn = (p) => {
      p.stdout("partial");
    };
    const done = new Promise<unknown[]>((res) =>
      execFile("slow", [], { timeout: 20, killSignal: "SIGKILL" }, (...a: unknown[]) => res(a)),
    );
    await flush(60);
    expect(ipc.procs[0].kills).toEqual([{ signal: "SIGKILL", group: true }]);
    ipc.procs[0].exit(null, "SIGKILL");
    const [err, stdout] = (await done) as [Err, string];
    expect(err.killed).toBe(true);
    expect(err.signal).toBe("SIGKILL");
    expect(err.code).toBeNull();
    expect(stdout).toBe("partial");
  });

  it("maxBuffer exceeded kills the child and fails with ERR_CHILD_PROCESS_STDIO_MAXBUFFER", async () => {
    const { execFile } = cp();
    ipc.onSpawn = (p) => p.stdout("0123456789");
    const done = new Promise<unknown[]>((res) =>
      execFile("big", [], { maxBuffer: 4 }, (...a: unknown[]) => res(a)),
    );
    await flush(5);
    expect(ipc.procs[0].kills).toHaveLength(1);
    ipc.procs[0].exit(null, "SIGTERM");
    const [err, stdout] = (await done) as [Err, string];
    expect(err.code).toBe("ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
    expect(stdout).toBe("0123");
  });

  it("AbortSignal rejects with AbortError", async () => {
    const { execFile } = cp();
    const ac = new AbortController();
    const run = promisify(execFile as never) as (...a: unknown[]) => Promise<unknown>;
    const p = run("x", [], { signal: ac.signal }).catch((e: Err) => e);
    await flush();
    ac.abort();
    expect(((await p) as Err).name).toBe("AbortError");
  });

  it("refuses shell mode", () => {
    expect(() => cp().execFile("ls", { shell: true }, () => {})).toThrow(/shell execution/);
  });
});

describe("unsupported APIs fail clearly", () => {
  it("exec calls back / rejects with a not-supported error", async () => {
    const { exec } = cp();
    const err = await new Promise<Err>((res) => exec("ls -l", (e: Err) => res(e)));
    expect(err.code).toBe("ERR_SHELL_UNSUPPORTED");
    await expect(
      (promisify(exec as never) as (c: string) => Promise<unknown>)("ls"),
    ).rejects.toThrow(/not supported/);
    expect(ipc.procs).toHaveLength(0);
  });

  it("sync and fork variants throw", () => {
    const m = cp();
    for (const fn of [m.spawnSync, m.execSync, m.execFileSync, m.fork])
      expect(() => (fn as () => void)()).toThrow(/not supported in this host/);
  });
});

describe("plugin identity", () => {
  it("parses the plugin id from a stack containing the script's sourceURL", () => {
    const stack = `Error\n    at spawn (writer-plugin://localhost/copilot/main.js:10:5)\n    at x (writer-plugin://localhost/other/main.js:1:1)`;
    expect(pluginIdFromStack(stack)).toBe("copilot");
    expect(pluginIdFromStack("spawn@writer-plugin://localhost/my%20plugin/main.js:1:2")).toBe(
      "my plugin",
    );
    expect(pluginIdFromStack("at foo (http://localhost/app.js:1:1)")).toBeUndefined();
    expect(pluginIdFromStack(undefined)).toBeUndefined();
  });

  it("a resolver-based module (global require) tags requests with the resolved id, else 'unknown'", async () => {
    let id: string | undefined = "from-stack";
    const m = createChildProcessModule({ pluginId: () => id });
    m.spawn("a");
    id = undefined;
    m.spawn("b");
    await flush();
    expect(ipc.procs.map((p) => p.request.plugin_id)).toEqual(["from-stack", "unknown"]);
  });
});
