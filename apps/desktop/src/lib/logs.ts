// IPC of the log view (`src-tauri/src/commands/logs.rs`, ADR 2026-11-23): the last lines of an
// allowlisted target from today's file and a live feed of the lines after them. Both carry what
// the pipeline already redacted. Argument keys are camelCase, as Tauri reads them; a test checks
// them against the Rust parameter names.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type LogLevelName = "error" | "warn" | "info" | "debug" | "trace";

export interface LogLine {
  ts: string;
  level: LogLevelName;
  target: string;
  message: string;
  fields?: Record<string, unknown>;
}

/** The event a live feed emits to this window (`LINE_EVENT` in `commands/logs.rs`). */
export const LOG_LINE_EVENT = "log:line";

/** The most lines `logTail` returns (the Rust cap). */
export const LOG_TAIL_MAX = 500;

export const logTail = (target: string, limit: number): Promise<LogLine[]> =>
  invoke("log_tail", { target, limit });

export const logWatch = (target: string): Promise<number> => invoke("log_watch", { target });

export const logUnwatch = (id: number): Promise<void> => invoke("log_unwatch", { id });

/**
 * Opens a live feed of `target` and calls `onLine` for each line until the returned function runs.
 * The listener is attached before the feed opens, so no line falls between them; lines of other
 * feeds of this window are ignored. Resolves once the feed is open.
 */
export async function watchLog(
  target: string,
  onLine: (line: LogLine) => void,
): Promise<() => void> {
  let id: number | null = null;
  const early: { id: number; line: LogLine }[] = [];
  const unlisten = await listen<{ id: number; line: LogLine }>(LOG_LINE_EVENT, (e) => {
    if (id === null) early.push(e.payload);
    else if (e.payload.id === id) onLine(e.payload.line);
  });
  try {
    id = await logWatch(target);
  } catch (e) {
    unlisten();
    throw e;
  }
  const mine = id;
  early.filter((p) => p.id === mine).forEach((p) => onLine(p.line));
  return () => {
    unlisten();
    void logUnwatch(mine).catch(() => {});
  };
}
