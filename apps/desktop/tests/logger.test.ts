import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

import {
  createLogger,
  describeError,
  formatConsoleArgs,
  installGlobalLogging,
  MAX_MESSAGE,
  type InstallTarget,
  type LogEntry,
} from "../src/lib/logger";

function harness() {
  let t = 1_000;
  const sent: LogEntry[][] = [];
  let timer: (() => void) | null = null;
  const logger = createLogger({
    transport: (e) => void sent.push(e),
    now: () => t,
    schedule: (fn) => {
      timer = fn;
      return () => {
        timer = null;
      };
    },
  });
  return {
    logger,
    sent,
    advance: (ms: number) => void (t += ms),
    fireTimer: () => timer?.(),
    all: () => sent.flat(),
  };
}

describe("logger batching, dedupe and caps", () => {
  it("batches entries into one send on the flush timer", () => {
    const h = harness();
    h.logger.error("app", "one");
    h.logger.warn("app", "two");
    expect(h.sent).toHaveLength(0);
    h.fireTimer();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].map((e) => e.message)).toEqual(["one", "two"]);
  });

  it("sends at once when the buffer is full", () => {
    const h = harness();
    for (let i = 0; i < 50; i++) h.logger.error("app", `m${i}`);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toHaveLength(50);
  });

  it("sends a repeated message once, then reports the repeat count", () => {
    const h = harness();
    for (let i = 0; i < 20; i++) h.logger.error("console", "same");
    h.fireTimer();
    expect(h.all()).toHaveLength(2);
    expect(h.all()[0].repeats).toBeUndefined();
    expect(h.all()[1]).toMatchObject({ message: "same", repeats: 19 });
    h.logger.error("console", "same");
    h.logger.flush();
    expect(h.all()).toHaveLength(3);
    expect(h.all()[2].repeats).toBe(1);
  });

  it("treats a different plugin or phase as a different message", () => {
    const h = harness();
    h.logger.error("plugin", "x", { plugin: "a", phase: "load" });
    h.logger.error("plugin", "x", { plugin: "b", phase: "load" });
    h.logger.error("plugin", "x", { plugin: "a", phase: "command" });
    h.logger.flush();
    expect(h.all()).toHaveLength(3);
  });

  it("logs the message again after the dedupe window", () => {
    const h = harness();
    h.logger.error("app", "again");
    h.advance(61_000);
    h.logger.error("app", "again");
    h.logger.flush();
    expect(h.all().filter((e) => e.message === "again")).toHaveLength(2);
  });

  it("caps message and stack size", () => {
    const h = harness();
    h.logger.error("app", "m".repeat(50_000), { stack: "s".repeat(50_000) });
    h.logger.flush();
    const e = h.all()[0];
    expect(e.message.length).toBeLessThan(MAX_MESSAGE + 20);
    expect(e.stack!.length).toBeLessThan(8100);
  });

  it("rate limits a flood and reports the drop in the next window", () => {
    const h = harness();
    for (let i = 0; i < 300; i++) h.logger.error("app", `unique ${i}`);
    h.logger.flush();
    expect(h.all()).toHaveLength(100);
    h.advance(11_000);
    h.logger.error("app", "later");
    h.logger.flush();
    expect(h.all().some((e) => e.message.includes("dropped 200"))).toBe(true);
  });

  it("never throws when the transport does", () => {
    const logger = createLogger({
      transport: () => {
        throw new Error("ipc down");
      },
    });
    expect(() => {
      logger.error("app", "x");
      logger.flush();
    }).not.toThrow();
  });

  it("swallows a rejecting transport", async () => {
    const logger = createLogger({ transport: () => Promise.reject(new Error("no")) });
    logger.error("app", "x");
    logger.flush();
    await Promise.resolve();
  });
});

describe("formatting", () => {
  it("describes errors, strings and objects", () => {
    expect(describeError(new TypeError("bad")).message).toBe("TypeError: bad");
    expect(describeError("plain").message).toBe("plain");
    expect(describeError({ a: 1 }).message).toBe('{"a":1}');
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(describeError(cyc).message).toBe("unserializable value");
  });

  it("joins console args and keeps the first stack", () => {
    const err = new Error("boom");
    const out = formatConsoleArgs(["[plugin] x failed:", err, { k: 1 }]);
    expect(out.message).toBe('[plugin] x failed: Error: boom {"k":1}');
    expect(out.stack).toBe(err.stack);
  });
});

describe("global handler wiring", () => {
  let handlers: Map<string, (e: any) => void>;
  let target: InstallTarget;
  let con: { error: (...a: unknown[]) => void; warn: (...a: unknown[]) => void };
  let origError: (...a: unknown[]) => void;
  let origWarn: (...a: unknown[]) => void;
  let errorSpy: ReturnType<typeof vi.fn<(...a: unknown[]) => void>>;
  let warnSpy: ReturnType<typeof vi.fn<(...a: unknown[]) => void>>;
  let h: ReturnType<typeof harness>;
  let invokeImpl: ReturnType<typeof vi.fn>;
  let off: () => void;

  beforeEach(() => {
    handlers = new Map();
    invokeImpl = vi.fn(async (cmd: string) => {
      if (cmd === "bad") throw new Error("nope");
      return "ok";
    });
    target = {
      addEventListener: (t, fn) => void handlers.set(t, fn),
      removeEventListener: (t) => void handlers.delete(t),
      __TAURI_INTERNALS__: { invoke: invokeImpl as never },
    };
    errorSpy = vi.fn<(...a: unknown[]) => void>();
    warnSpy = vi.fn<(...a: unknown[]) => void>();
    origError = (...a) => errorSpy(...a);
    origWarn = (...a) => warnSpy(...a);
    con = { error: origError, warn: origWarn };
    h = harness();
    off = installGlobalLogging(target, h.logger, con);
  });
  afterEach(() => off());

  it("forwards console.error and console.warn and still calls the originals", () => {
    con.error("[plugin] x", new Error("e1"));
    con.warn("careful");
    h.logger.flush();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith("careful");
    expect(h.all().map((e) => [e.level, e.source, e.message])).toEqual([
      ["error", "console", "[plugin] x Error: e1"],
      ["warn", "console", "careful"],
    ]);
  });

  it("forwards window errors with location and stack", () => {
    const error = new Error("script broke");
    handlers.get("error")!({ error, message: "x", filename: "app.js", lineno: 3, colno: 4 });
    h.logger.flush();
    expect(h.all()[0]).toMatchObject({
      source: "window.onerror",
      message: "Error: script broke (app.js:3:4)",
    });
    expect(h.all()[0].stack).toContain("script broke");
  });

  it("forwards unhandled rejections", () => {
    handlers.get("unhandledrejection")!({ reason: new RangeError("deep") });
    handlers.get("unhandledrejection")!({ reason: "just text" });
    h.logger.flush();
    expect(h.all().map((e) => e.message)).toEqual(["RangeError: deep", "just text"]);
  });

  it("flushes when the page is hidden", () => {
    h.logger.error("app", "last words");
    handlers.get("pagehide")!({});
    expect(h.all()).toHaveLength(1);
  });

  it("logs a failed IPC command by name and still rejects to the caller", async () => {
    const internals = target.__TAURI_INTERNALS__!;
    await expect(internals.invoke!("bad", { secret: "payload" })).rejects.toThrow("nope");
    await expect(internals.invoke!("fine")).resolves.toBe("ok");
    h.logger.flush();
    expect(h.all()).toHaveLength(1);
    expect(h.all()[0]).toMatchObject({ source: "ipc", phase: "bad", level: "warn" });
    expect(h.all()[0].message).toBe("command bad failed: Error: nope");
    expect(JSON.stringify(h.all())).not.toContain("payload");
  });

  it("does not throw when Tauri's invoke is read-only (WebKit aborts startup otherwise)", () => {
    off();
    const frozen = Object.freeze({ invoke: invokeImpl as never });
    const ro = {
      addEventListener: (t: string, fn: unknown) => void handlers.set(t, fn as never),
      removeEventListener: (t: string) => void handlers.delete(t),
      __TAURI_INTERNALS__: frozen,
    };
    const local = harness();
    let stop: () => void = () => {};
    expect(() => {
      stop = installGlobalLogging(ro as never, local.logger, con);
    }).not.toThrow();
    expect(ro.__TAURI_INTERNALS__.invoke).toBe(invokeImpl);
    expect(() => stop()).not.toThrow();
    off = installGlobalLogging(target, h.logger, con);
  });

  it("does not log its own log_event failures", async () => {
    invokeImpl.mockRejectedValueOnce(new Error("sink down"));
    await expect(target.__TAURI_INTERNALS__!.invoke!("log_event", {})).rejects.toThrow();
    h.logger.flush();
    expect(h.all()).toHaveLength(0);
  });

  it("is idempotent and uninstalls cleanly", () => {
    expect(installGlobalLogging(target, h.logger, con)).toBe(off);
    off();
    expect(con.error).toBe(origError);
    expect(handlers.size).toBe(0);
    expect(target.__TAURI_INTERNALS__!.invoke).toBe(invokeImpl);
  });
});
