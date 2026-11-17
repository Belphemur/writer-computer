// Opt-in timing of host IPC round trips, for diagnosing "the plugin pane is slow" reports.
// Off by default (one boolean check per call). Enable in the webview console with
//   localStorage.setItem("writer.hostIpcTrace", "1")   // then reload
// and read the aggregate with `__writerHostIpcStats()`; slow calls (>= SLOW_MS) are also logged.
// Arguments and results are never logged (they hold note content and paths).

const SLOW_MS = 50;

interface Stat {
  count: number;
  totalMs: number;
  maxMs: number;
}

const stats = new Map<string, Stat>();

function enabled(): boolean {
  try {
    return globalThis.localStorage?.getItem("writer.hostIpcTrace") === "1";
  } catch {
    return false;
  }
}

const on = enabled();
if (on) {
  (globalThis as Record<string, unknown>).__writerHostIpcStats = (): Record<string, Stat> =>
    Object.fromEntries(stats);
}

/** Runs `run`; when tracing is on, records its duration under `cmd`. */
export function traceIpc<T>(cmd: string, run: () => Promise<T>): Promise<T> {
  if (!on) return run();
  const start = performance.now();
  const done = (): void => {
    const ms = performance.now() - start;
    const s = stats.get(cmd) ?? { count: 0, totalMs: 0, maxMs: 0 };
    s.count++;
    s.totalMs += ms;
    s.maxMs = Math.max(s.maxMs, ms);
    stats.set(cmd, s);
    if (ms >= SLOW_MS) console.debug(`[host-ipc] slow ${cmd} ${ms.toFixed(1)}ms`);
  };
  return run().finally(done);
}
