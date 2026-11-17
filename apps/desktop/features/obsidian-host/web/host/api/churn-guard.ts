// Safety net for plugins whose own file changes keep triggering themselves (a skill seeder that
// re-seeds on every vault event, two apps with different state fighting over one folder). It
// only observes: the plugin is never blocked, and the warning is logged once per plugin so the
// log shows which plugin churns and which path, instead of a user finding a busy CPU.
import { logger } from "@/lib/logger";

export const CHURN_SHORT_WINDOW_MS = 10_000;
export const CHURN_SHORT_MAX = 20;
export const CHURN_LONG_WINDOW_MS = 60_000;
export const CHURN_LONG_MAX = 30;
const MAX_KEYS = 500;

const history = new Map<string, number[]>();
const warned = new Set<string>();

/** Test hook. */
export function resetChurnGuard(): void {
  history.clear();
  warned.clear();
}

/**
 * Records one plugin-driven write or delete of `path`. Warns once per plugin when the same path
 * changes more than 20 times in 10 s (or 30 times in a minute: a slow two-party fight).
 * `now` is injectable for tests.
 */
export function recordPluginMutation(
  plugin: string,
  path: string,
  op: string,
  now: number = Date.now(),
): void {
  if (warned.has(plugin)) return;
  const key = `${plugin}\u0000${path}`;
  const times = (history.get(key) ?? []).filter((t) => now - t < CHURN_LONG_WINDOW_MS);
  times.push(now);
  history.set(key, times);
  if (history.size > MAX_KEYS) {
    for (const [k, v] of history) {
      if (now - v[v.length - 1] >= CHURN_LONG_WINDOW_MS) history.delete(k);
    }
    if (history.size > MAX_KEYS) history.delete(history.keys().next().value as string);
  }
  const short = times.filter((t) => now - t < CHURN_SHORT_WINDOW_MS).length;
  if (short <= CHURN_SHORT_MAX && times.length <= CHURN_LONG_MAX) return;
  warned.add(plugin);
  logger.warn(
    "plugin",
    `${plugin} changed ${path} ${times.length} times in ${Math.round(
      (now - times[0]) / 1000,
    )}s (last: ${op}); a plugin that re-triggers itself, or another app fighting over the same files, can keep the vault busy`,
    { plugin },
  );
}
