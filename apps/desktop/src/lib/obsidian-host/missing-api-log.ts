// Diagnostic for unimplemented Obsidian API. Plugins feature-detect or call members the host does
// not have; the bare outcome is `TypeError: x is not a function` far from the cause. When enabled,
// the `app` a plugin receives (and its workspace / vault / vault.adapter / metadataCache /
// fileManager) is wrapped in a Proxy that logs ONCE per missing property path with the plugin id.
// It never changes behaviour: a missing member still reads as `undefined`.
//
// Enabled in dev builds, or in any build by `localStorage["writer.plugins.debug"] = "1"` /
// `globalThis.__WRITER_PLUGIN_DEBUG__ = true`. Off (no Proxy at all) otherwise.
import type { App } from "./api/app";

export type MissingApiSink = (pluginId: string, path: string) => void;

// Property reads that probe objects generically (promise/JSON/test-framework protocols) are not API.
const PROBES = new Set([
  "then",
  "toJSON",
  "asymmetricMatch",
  "nodeType",
  "$$typeof",
  "constructor",
  "length",
  "inspect",
  "prototype",
  "__esModule",
  "toString",
  "valueOf",
]);
const WRAPPED = ["workspace", "vault", "metadataCache", "fileManager", "adapter"] as const;

const defaultSink: MissingApiSink = (pluginId, path) =>
  console.warn(
    `[plugin-api] "${pluginId}" used unimplemented ${path} (reads as undefined). ` +
      "Add it to the host or report it.",
  );

export function isMissingApiLogEnabled(): boolean {
  try {
    if ((globalThis as { __WRITER_PLUGIN_DEBUG__?: boolean }).__WRITER_PLUGIN_DEBUG__) return true;
    if (typeof localStorage !== "undefined" && localStorage.getItem("writer.plugins.debug") === "1")
      return true;
  } catch {
    // storage blocked: fall through
  }
  return Boolean(import.meta.env?.DEV);
}

/** Wraps `app` for one plugin. `seen` is shared so a path is reported once per plugin per host. */
export function wrapAppForDiagnostics(
  app: App,
  pluginId: string,
  sink: MissingApiSink = defaultSink,
  seen: Set<string> = new Set(),
): App {
  const cache = new WeakMap<object, object>();
  const wrap = <T extends object>(target: T, path: string): T => {
    const hit = cache.get(target);
    if (hit) return hit as T;
    const proxy = new Proxy(target, {
      get(obj, prop, receiver) {
        const value = Reflect.get(obj, prop, receiver);
        if (typeof prop !== "string") return value;
        if (value === undefined) {
          if (!PROBES.has(prop) && !(prop in obj)) {
            const full = `${path}.${prop}`;
            const key = `${pluginId}\0${full}`;
            if (!seen.has(key)) {
              seen.add(key);
              sink(pluginId, full);
            }
          }
          return value;
        }
        if (
          (WRAPPED as readonly string[]).includes(prop) &&
          value !== null &&
          typeof value === "object"
        )
          return wrap(value as object, `${path}.${prop}`);
        return value;
      },
    });
    cache.set(target, proxy);
    return proxy;
  };
  return wrap(app, "app");
}
