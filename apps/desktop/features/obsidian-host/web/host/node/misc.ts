// Small modules: `net`, `zlib`, `electron`, `url`, `module`.
import { recordPluginError } from "../error-log";
import { messageOf, nodeError } from "./errors";
import { Server } from "./http";
import { pathModule } from "./path";
import { getNodeIpc } from "./state";

// ---------------------------------------------------------------- net

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const isIPv4 = (s: string): boolean => IPV4.test(s);
const isIPv6 = (s: string): boolean =>
  /^[0-9a-fA-F:.]+$/.test(s) && s.includes(":") && s.split("::").length <= 2;

const noSockets = (name: string) => (): never => {
  throw nodeError(
    "ERR_NET_UNSUPPORTED",
    `net.${name}() is not supported in Writer: raw sockets are unavailable`,
  );
};

export const netModule = {
  isIP: (s: string): 0 | 4 | 6 => (isIPv4(s) ? 4 : isIPv6(s) ? 6 : 0),
  isIPv4,
  isIPv6,
  createServer: (...args: unknown[]): Server => new Server(...args),
  Server,
  connect: noSockets("connect"),
  createConnection: noSockets("createConnection"),
  Socket: class Socket {
    constructor() {
      noSockets("Socket")();
    }
  },
};

// ---------------------------------------------------------------- zlib

const noZlib = (name: string) => (): never => {
  throw nodeError("ERR_ZLIB_UNSUPPORTED", `zlib.${name}() is not supported in Writer`);
};
export const zlibModule: Record<string, unknown> = { constants: {} };
for (const n of [
  "gzip",
  "gunzip",
  "deflate",
  "inflate",
  "deflateRaw",
  "inflateRaw",
  "unzip",
  "brotliCompress",
  "brotliDecompress",
  "gzipSync",
  "gunzipSync",
  "deflateSync",
  "inflateSync",
  "createGzip",
  "createGunzip",
  "createDeflate",
  "createInflate",
  "createUnzip",
])
  zlibModule[n] = noZlib(n);

// ---------------------------------------------------------------- electron

export type OpenExternal = (url: string) => Promise<void>;

// Rust (`plugin_open_url`) owns the scheme check and the trusted-vault gate.
const defaultOpenExternal: OpenExternal = (url) => getNodeIpc().openUrl(url);
let openExternalImpl: OpenExternal = defaultOpenExternal;
/** Test seam / host override for `electron.shell.openExternal`. `null` restores the default. */
export function setOpenExternal(fn: OpenExternal | null): void {
  openExternalImpl = fn ?? defaultOpenExternal;
}

const OPENABLE = new Set(["http:", "https:", "mailto:"]);

const notSupported = (what: string) => nodeError("ENOSYS", `${what} is not supported in Writer`);

/**
 * `ipcRenderer` never throws synchronously: callers such as Copilot's CLI client call
 * `sendSync` at load and tolerate `undefined`.
 */
const ipcRenderer = {
  sendSync: (): undefined => undefined,
  send: (): void => {},
  sendToHost: (): void => {},
  invoke: (channel: string): Promise<never> =>
    Promise.reject(notSupported(`electron.ipcRenderer.invoke("${String(channel)}")`)),
  on: function (this: unknown) {
    return this;
  },
  once: function (this: unknown) {
    return this;
  },
  addListener: function (this: unknown) {
    return this;
  },
  removeListener: function (this: unknown) {
    return this;
  },
  off: function (this: unknown) {
    return this;
  },
  removeAllListeners: function (this: unknown) {
    return this;
  },
};

export const electronModule = {
  ipcRenderer,
  remote: undefined,
  shell: {
    async openExternal(url: string): Promise<void> {
      let protocol: string;
      try {
        protocol = new URL(String(url)).protocol;
      } catch {
        throw nodeError("ERR_INVALID_URL", `Invalid URL: ${String(url)}`);
      }
      if (!OPENABLE.has(protocol))
        throw nodeError(
          "EPERM",
          `shell.openExternal: scheme ${protocol} is not allowed (http, https, mailto only)`,
        );
      await openExternalImpl(String(url));
    },
    /** Electron resolves with "" on success and an error message otherwise. */
    async openPath(path: string): Promise<string> {
      try {
        await getNodeIpc().openPath(String(path), false);
        return "";
      } catch (e) {
        return messageOf(e);
      }
    },
    /** Electron's returns void and never throws; failures are recorded, not swallowed. */
    showItemInFolder(path: string): void {
      getNodeIpc()
        .openPath(String(path), true)
        .catch((e: unknown) => {
          console.error("[plugin] showItemInFolder failed:", e);
          recordPluginError("host", "show-item-in-folder", e);
        });
    },
  },
};

// ---------------------------------------------------------------- url

export function fileURLToPath(url: string | URL): string {
  const u = typeof url === "string" ? new URL(url) : url;
  if (u.protocol !== "file:")
    throw nodeError("ERR_INVALID_URL_SCHEME", "The URL must be of scheme file");
  return decodeURIComponent(u.pathname);
}
export function pathToFileURL(path: string): URL {
  return new URL(
    `file://${encodeURI(pathModule.resolve(path)).replace(/[?#]/g, encodeURIComponent)}`,
  );
}
/** Legacy `url.parse` (subset: protocol, host, hostname, port, pathname, search, query, hash, href). */
export function parse(input: string, parseQuery = false) {
  let u: URL | null = null;
  try {
    u = new URL(input);
  } catch {
    u = null;
  }
  if (!u) {
    const [pathAndQuery, hash = null] = input.split("#");
    const [pathname, search = null] = pathAndQuery.split("?");
    return {
      protocol: null,
      host: null,
      hostname: null,
      port: null,
      pathname: pathname || null,
      search: search === null ? null : `?${search}`,
      query: parseQuery ? Object.fromEntries(new URLSearchParams(search ?? "")) : (search ?? null),
      hash: hash === null ? null : `#${hash}`,
      href: input,
    };
  }
  return {
    protocol: u.protocol,
    host: u.host,
    hostname: u.hostname,
    port: u.port || null,
    pathname: u.pathname,
    search: u.search || null,
    query: parseQuery ? Object.fromEntries(u.searchParams) : u.search.slice(1) || null,
    hash: u.hash || null,
    href: u.href,
  };
}
export const urlModule = { URL, URLSearchParams, fileURLToPath, pathToFileURL, parse };

// ---------------------------------------------------------------- async_hooks

/**
 * Minimal AsyncLocalStorage over a synchronous context stack: `getStore()` is correct inside
 * `run()`/`exit()` callbacks and anything they call synchronously. Context does NOT propagate
 * across `await`/timers (there is no async_hooks in a WebView); `enterWith` sets the store until
 * changed. Enough for SDKs that construct one at module scope and read it opportunistically.
 */
export class AsyncLocalStorage<T = unknown> {
  private store: T | undefined;
  getStore(): T | undefined {
    return this.store;
  }
  run<R>(store: T, fn: (...args: any[]) => R, ...args: any[]): R {
    const prev = this.store;
    this.store = store;
    try {
      return fn(...args);
    } finally {
      this.store = prev;
    }
  }
  exit<R>(fn: (...args: any[]) => R, ...args: any[]): R {
    const prev = this.store;
    this.store = undefined;
    try {
      return fn(...args);
    } finally {
      this.store = prev;
    }
  }
  enterWith(store: T): void {
    this.store = store;
  }
  disable(): void {
    this.store = undefined;
  }
}
export const asyncHooksModule = { AsyncLocalStorage };

// ---------------------------------------------------------------- module

export function createModuleModule(require: (id: string) => unknown, builtins: readonly string[]) {
  return {
    createRequire: (): ((id: string) => unknown) => require,
    builtinModules: [...builtins],
    isBuiltin: (id: string): boolean => builtins.includes(String(id).replace(/^node:/, "")),
  };
}
