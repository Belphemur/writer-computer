// The Node module table behind `require(id)`. Shared modules are singletons (so `instanceof
// EventEmitter` and Buffer identity hold across plugins); `child_process`, `fs`, `fs/promises`
// and `module` are per-context (they need the plugin id / the vault IO / the `require` itself).
import type { VaultIo } from "../api/vault";
import { bufferModule } from "./buffer";
import { createChildProcessModule, type PluginIdSource } from "./child-process";
import { cryptoModule } from "./crypto";
import { EventEmitter } from "./events";
import {
  constantsModule,
  diagnosticsChannelModule,
  domainModule,
  perfHooksModule,
  punycodeModule,
  querystringModule,
  timersModule,
  timersPromisesModule,
  ttyModule,
  v8Module,
  vmModule,
  workerThreadsModule,
} from "./extra-modules";
import { createFsModule } from "./fs";
import { createHttpModule } from "./http";
import {
  asyncHooksModule,
  createModuleModule,
  electronModule,
  netModule,
  urlModule,
  zlibModule,
} from "./misc";
import { osModule } from "./os";
import { pathModule, posix, win32 } from "./path";
import { getSharedProcess } from "./process";
import { readlineModule } from "./readline";
import { promises as streamPromises, streamModule } from "./stream";
import { StringDecoder } from "./string-decoder";
import { types, utilModule } from "./util";

export interface NodeRegistryContext {
  pluginId: PluginIdSource;
  io?: VaultIo;
  /** The `require` handed to code (returned by `module.createRequire`). */
  require: (id: string) => unknown;
}

const httpModule = createHttpModule("http:");
const httpsModule = createHttpModule("https:");

const SHARED: Readonly<Record<string, () => unknown>> = {
  events: () => EventEmitter,
  buffer: () => bufferModule,
  util: () => utilModule,
  "util/types": () => types,
  string_decoder: () => ({ StringDecoder }),
  path: () => pathModule,
  "path/posix": () => posix,
  "path/win32": () => win32,
  os: () => osModule,
  process: () => getSharedProcess(),
  stream: () => streamModule,
  "stream/promises": () => streamPromises,
  readline: () => readlineModule,
  crypto: () => cryptoModule,
  http: () => httpModule,
  https: () => httpsModule,
  net: () => netModule,
  zlib: () => zlibModule,
  url: () => urlModule,
  async_hooks: () => asyncHooksModule,
  electron: () => electronModule,
  diagnostics_channel: () => diagnosticsChannelModule,
  perf_hooks: () => perfHooksModule,
  worker_threads: () => workerThreadsModule,
  tty: () => ttyModule,
  v8: () => v8Module,
  vm: () => vmModule,
  constants: () => constantsModule,
  querystring: () => querystringModule,
  punycode: () => punycodeModule,
  domain: () => domainModule,
  timers: () => timersModule,
  "timers/promises": () => timersPromisesModule,
  sys: () => utilModule,
};
const PER_CONTEXT = ["child_process", "fs", "fs/promises", "module"] as const;

/** Every id `require` can resolve (without the `node:` prefix). */
export const NODE_MODULE_IDS: readonly string[] = [...Object.keys(SHARED), ...PER_CONTEXT];

export interface NodeRegistry {
  has(id: string): boolean;
  /** `id` may carry the `node:` prefix. Throws nothing: callers check `has` first. */
  get(id: string): unknown;
}

export function createNodeRegistry(ctx: NodeRegistryContext): NodeRegistry {
  const cache = new Map<string, unknown>();
  let fs: ReturnType<typeof createFsModule> | null = null;
  const strip = (id: string): string => (id.startsWith("node:") ? id.slice(5) : id);
  return {
    has: (id) => NODE_MODULE_IDS.includes(strip(id)),
    get(rawId) {
      const id = strip(rawId);
      if (cache.has(id)) return cache.get(id);
      let value: unknown;
      if (Object.prototype.hasOwnProperty.call(SHARED, id)) value = SHARED[id]();
      else if (id === "child_process") value = createChildProcessModule({ pluginId: ctx.pluginId });
      else if (id === "fs" || id === "fs/promises") {
        fs ??= createFsModule({ io: ctx.io, pluginId: ctx.pluginId });
        value = id === "fs" ? fs.fs : fs.promises;
      } else if (id === "module") value = createModuleModule(ctx.require, NODE_MODULE_IDS);
      cache.set(id, value);
      return value;
    },
  };
}
