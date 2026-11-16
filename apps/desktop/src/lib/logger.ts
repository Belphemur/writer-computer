// The one module that talks to the Rust `log_event` command: everything the frontend wants in
// the local log files (see docs/decisions/2026-11-16-always-write-local-error-logs.md) goes
// through `logger`. Entries are buffered, deduplicated per message, rate limited and size
// capped here; Rust redacts paths and secrets and applies the configured level. Logs never
// leave the machine.
//
// This module must never call `console.*` or throw: it is what the console wrapper feeds.
import { invoke } from "@tauri-apps/api/core";

export type LogLevel = "error" | "warn" | "info" | "debug";

export interface LogEntry {
  level: LogLevel;
  /** `console`, `window.onerror`, `unhandledrejection`, `react`, `plugin`, `ipc`, `app`. */
  source: string;
  message: string;
  stack?: string;
  plugin?: string;
  phase?: string;
  version?: string;
  /** Identical entries suppressed since this one was last sent. */
  repeats?: number;
}

export type LogContext = Pick<LogEntry, "stack" | "plugin" | "phase" | "version">;

export const MAX_MESSAGE = 4000;
export const MAX_STACK = 8000;
const FLUSH_MS = 1000;
const MAX_BUFFER = 50;
const DEDUPE_MS = 60_000;
const MAX_KEYS = 500;
const RATE_WINDOW_MS = 10_000;
const RATE_MAX = 100;

export type Transport = (entries: LogEntry[]) => Promise<unknown> | unknown;

export interface LoggerDeps {
  transport: Transport;
  now?: () => number;
  /** Schedules the flush timer; returns a cancel function. */
  schedule?: (fn: () => void, ms: number) => () => void;
}

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…[truncated]` : text;
}

/** Message and stack of anything that was thrown. */
export function describeError(e: unknown): { message: string; stack?: string } {
  if (e instanceof Error) return { message: `${e.name}: ${e.message}`, stack: e.stack };
  if (typeof e === "string") return { message: e };
  try {
    return { message: JSON.stringify(e) ?? String(e) };
  } catch {
    return { message: "unserializable value" };
  }
}

/** `console.error(...args)` as one message: errors by name and message, objects as capped JSON. */
export function formatConsoleArgs(args: readonly unknown[]): { message: string; stack?: string } {
  let stack: string | undefined;
  const parts = args.map((a) => {
    if (a instanceof Error) {
      stack ??= a.stack;
      return `${a.name}: ${a.message}`;
    }
    if (typeof a === "string") return a;
    return cap(describeError(a).message, 1000);
  });
  return { message: parts.join(" "), stack };
}

export interface Logger {
  log(level: LogLevel, source: string, message: string, ctx?: LogContext): void;
  error(source: string, message: string, ctx?: LogContext): void;
  warn(source: string, message: string, ctx?: LogContext): void;
  /** Sends what is buffered now. */
  flush(): void;
}

export function createLogger(deps: LoggerDeps): Logger {
  const now = deps.now ?? Date.now;
  const schedule =
    deps.schedule ??
    ((fn, ms) => {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    });

  let buffer: LogEntry[] = [];
  let cancelTimer: (() => void) | null = null;
  const seen = new Map<string, { at: number; suppressed: number; entry: LogEntry }>();
  let windowStart = 0;
  let windowCount = 0;
  let windowDropped = 0;

  function send(entries: LogEntry[]) {
    try {
      const r = deps.transport(entries);
      if (r && typeof (r as Promise<unknown>).catch === "function") {
        (r as Promise<unknown>).catch(() => {});
      }
    } catch {
      // the log pipe must never break the app
    }
  }

  function flush() {
    cancelTimer?.();
    cancelTimer = null;
    const t = now();
    for (const [key, s] of seen) {
      if (s.suppressed > 0) {
        buffer.push({ ...s.entry, repeats: s.suppressed });
        s.suppressed = 0;
      } else if (t - s.at >= DEDUPE_MS) {
        seen.delete(key);
      }
    }
    if (buffer.length === 0) return;
    const out = buffer;
    buffer = [];
    send(out);
  }

  function enqueue(entry: LogEntry) {
    buffer.push(entry);
    if (buffer.length >= MAX_BUFFER) flush();
    else if (!cancelTimer) cancelTimer = schedule(flush, FLUSH_MS);
  }

  function log(level: LogLevel, source: string, message: string, ctx: LogContext = {}) {
    try {
      const t = now();
      const entry: LogEntry = {
        level,
        source,
        message: cap(message, MAX_MESSAGE),
        ...(ctx.stack ? { stack: cap(ctx.stack, MAX_STACK) } : {}),
        ...(ctx.plugin ? { plugin: ctx.plugin } : {}),
        ...(ctx.phase ? { phase: ctx.phase } : {}),
        ...(ctx.version ? { version: ctx.version } : {}),
      };
      const key = [level, source, entry.plugin, entry.phase, entry.message.slice(0, 300)].join(
        "\0",
      );
      const hit = seen.get(key);
      if (hit && t - hit.at < DEDUPE_MS) {
        hit.suppressed++;
        return;
      }
      if (t - windowStart >= RATE_WINDOW_MS) {
        if (windowDropped > 0) {
          enqueue({
            level: "warn",
            source: "app",
            message: `frontend logger dropped ${windowDropped} entries (rate limit)`,
          });
        }
        windowStart = t;
        windowCount = 0;
        windowDropped = 0;
      }
      if (windowCount >= RATE_MAX) {
        windowDropped++;
        return;
      }
      windowCount++;
      if (seen.size >= MAX_KEYS) seen.delete(seen.keys().next().value as string);
      seen.set(key, { at: t, suppressed: 0, entry });
      enqueue(entry);
    } catch {
      // never throw from the logger
    }
  }

  return {
    log,
    error: (source, message, ctx) => log("error", source, message, ctx),
    warn: (source, message, ctx) => log("warn", source, message, ctx),
    flush,
  };
}

/** The app's logger: batches go to Rust in one `log_event` call. */
export const logger: Logger = createLogger({
  transport: (entries) => invoke("log_event", { entries }),
});

// ---------- Global wiring ----------

type Fn = (...args: unknown[]) => unknown;
interface Internals {
  invoke?: (cmd: string, args?: unknown, options?: unknown) => Promise<unknown>;
}
export interface InstallTarget {
  addEventListener: (type: string, fn: (e: any) => void) => void;
  removeEventListener: (type: string, fn: (e: any) => void) => void;
  __TAURI_INTERNALS__?: Internals;
}

/** Console methods as they were before wrapping; the logger echoes through these. */
const rawConsole: { error: Fn; warn: Fn } = {
  error: (...a) => console.error(...a),
  warn: (...a) => console.warn(...a),
};

/** Logs and also prints to the real console (for sites that have no `console.*` call of their
 *  own, e.g. the missing-API diagnostic). */
export function logAndEcho(
  level: "error" | "warn",
  source: string,
  message: string,
  ctx?: LogContext,
): void {
  logger.log(level, source, message, ctx);
  try {
    rawConsole[level](message);
  } catch {
    // ignore
  }
}

let uninstall: (() => void) | null = null;

/**
 * Forwards `window.onerror`, `unhandledrejection`, `console.error` / `console.warn` (original
 * behavior kept) and failed IPC commands to `log`. Idempotent; returns the uninstall function.
 */
export function installGlobalLogging(
  target: InstallTarget = window as unknown as InstallTarget,
  log: Logger = logger,
  con: { error: Fn; warn: Fn } = console as unknown as { error: Fn; warn: Fn },
): () => void {
  if (uninstall) return uninstall;
  const origError = con.error;
  const origWarn = con.warn;
  rawConsole.error = (...a) => origError.apply(con, a);
  rawConsole.warn = (...a) => origWarn.apply(con, a);
  let inside = false;
  const wrap = (level: "error" | "warn", orig: Fn): Fn =>
    function (this: unknown, ...args: unknown[]) {
      try {
        return orig.apply(con, args);
      } finally {
        if (!inside) {
          inside = true;
          try {
            const { message, stack } = formatConsoleArgs(args);
            log.log(level, "console", message, { stack });
          } finally {
            inside = false;
          }
        }
      }
    };
  con.error = wrap("error", origError);
  con.warn = wrap("warn", origWarn);

  const onError = (e: ErrorEvent) => {
    const where = e.filename ? ` (${e.filename}:${e.lineno}:${e.colno})` : "";
    const fromError = e.error != null ? describeError(e.error) : null;
    log.error("window.onerror", `${fromError?.message ?? e.message}${where}`, {
      stack: fromError?.stack,
    });
  };
  const onRejection = (e: PromiseRejectionEvent) => {
    const d = describeError(e.reason);
    log.error("unhandledrejection", d.message, { stack: d.stack });
  };
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  const flushOnHide = () => log.flush();
  target.addEventListener("pagehide", flushOnHide);
  target.addEventListener("beforeunload", flushOnHide);

  // Tauri's `invoke` on the internals object can be read-only (WebKit throws on assignment and
  // aborts startup), so wrap it only when it is writable and never let the wrapper break boot.
  // Rejections nobody handles still reach the `unhandledrejection` handler above.
  const internals = target.__TAURI_INTERNALS__;
  const origInvoke = internals?.invoke;
  let wrappedInvoke = false;
  if (internals && origInvoke) {
    try {
      const desc = Object.getOwnPropertyDescriptor(internals, "invoke");
      if (!desc || desc.writable || desc.set) {
        internals.invoke = (cmd, args, options) => {
          const p = origInvoke.call(internals, cmd, args, options);
          if (cmd === "log_event") return p;
          return p.catch((err: unknown) => {
            log.warn("ipc", `command ${cmd} failed: ${describeError(err).message}`, {
              phase: cmd,
            });
            throw err;
          });
        };
        wrappedInvoke = true;
      }
    } catch {
      wrappedInvoke = false;
    }
  }

  uninstall = () => {
    con.error = origError;
    con.warn = origWarn;
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
    target.removeEventListener("pagehide", flushOnHide);
    target.removeEventListener("beforeunload", flushOnHide);
    if (internals && origInvoke && wrappedInvoke) {
      try {
        internals.invoke = origInvoke;
      } catch {
        // read-only: nothing was wrapped
      }
    }
    uninstall = null;
  };
  return uninstall;
}
