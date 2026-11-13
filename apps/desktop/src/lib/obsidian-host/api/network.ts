// Plugin-scoped networking: Obsidian's `requestUrl`/`request` and a Fetch-API-compatible `fetch`,
// both routed through the trusted-vault Rust commands (plugin_http_*), so they are free of the
// page CSP and CORS. Clean-room: written from the public Fetch / Obsidian API surface.
//
// Policy lives in Rust (scheme gate, metadata-endpoint block, size caps, 16 concurrent streams).
// This file never logs: bodies, URLs' query strings and Authorization headers stay out of every
// console call and error message it builds (Rust's own error text is passed through verbatim).
import { Channel, invoke } from "@tauri-apps/api/core";

// ---------------------------------------------------------------- IPC boundary

export interface HttpRequestWire {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  body_base64?: string;
  timeout_ms?: number;
  follow_redirects?: boolean;
}

export interface HttpResponseWire {
  status: number;
  headers: [string, string][];
  body_base64: string;
  url: string;
}

export type StreamEventWire =
  | { type: "head"; status: number; headers: [string, string][]; url: string }
  | { type: "chunk"; data_base64: string }
  | { type: "end" }
  | { type: "error"; message: string };

/** Backend boundary of the network layer; tests fake it. */
export interface NetIpc {
  request(request: HttpRequestWire): Promise<HttpResponseWire>;
  /** Resolves with the stream id. Events may be delivered before it resolves. */
  streamStart(request: HttpRequestWire, onEvent: (ev: StreamEventWire) => void): Promise<number>;
  streamCancel(streamId: number): Promise<boolean>;
}

export const tauriNetIpc: NetIpc = {
  request: (request) => invoke("plugin_http_request", { request }),
  streamStart: (request, onEvent) => {
    const channel = new Channel<StreamEventWire>();
    channel.onmessage = onEvent;
    return invoke("plugin_http_stream_start", { request, channel });
  },
  streamCancel: (streamId) => invoke("plugin_http_stream_cancel", { streamId }),
};

let activeIpc: NetIpc = tauriNetIpc;

/** Test seam: swap the backend (pass null to restore the Tauri one). */
export function setNetIpc(ipc: NetIpc | null): void {
  activeIpc = ipc ?? tauriNetIpc;
}

// ---------------------------------------------------------------- helpers

/** Tauri rejects with a string or a serialized AppError ({message} / {kind, message}). */
export function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object") {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return "network error";
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const STEP = 0x8000;
  for (let i = 0; i < bytes.length; i += STEP) {
    bin += String.fromCharCode(...bytes.subarray(i, i + STEP));
  }
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------- requestUrl

export interface RequestUrlParam {
  url: string;
  method?: string;
  contentType?: string;
  body?: string | ArrayBuffer;
  headers?: Record<string, string>;
  throw?: boolean;
}

export interface RequestUrlResponse {
  status: number;
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
  json: unknown;
  text: string;
}

export interface RequestUrlResponsePromise extends Promise<RequestUrlResponse> {
  readonly arrayBuffer: Promise<ArrayBuffer>;
  readonly json: Promise<unknown>;
  readonly text: Promise<string>;
}

export function requestUrl(request: RequestUrlParam | string): RequestUrlResponsePromise {
  const p: RequestUrlParam = typeof request === "string" ? { url: request } : request;
  const run = async (): Promise<RequestUrlResponse> => {
    const headers: Record<string, string> = { ...p.headers };
    if (p.contentType) {
      for (const k of Object.keys(headers))
        if (k.toLowerCase() === "content-type") delete headers[k];
      headers["Content-Type"] = p.contentType;
    }
    const wire: HttpRequestWire = { url: String(p.url), method: p.method ?? "GET", headers };
    if (typeof p.body === "string") wire.body = p.body;
    else if (p.body !== undefined && p.body !== null) {
      const view = ArrayBuffer.isView(p.body)
        ? new Uint8Array(p.body.buffer, p.body.byteOffset, p.body.byteLength)
        : new Uint8Array(p.body as ArrayBuffer);
      wire.body_base64 = bytesToBase64(view);
    }
    let res: HttpResponseWire;
    try {
      res = await activeIpc.request(wire);
    } catch (e) {
      throw new Error(`Request failed: ${errorText(e)}`);
    }
    const outHeaders: Record<string, string> = {};
    for (const [k, v] of res.headers) {
      const key = k.toLowerCase();
      outHeaders[key] = key in outHeaders ? `${outHeaders[key]}, ${v}` : v;
    }
    const bytes = base64ToBytes(res.body_base64);
    const buf = bytes.buffer;
    let text: string | undefined;
    const getText = (): string => (text ??= new TextDecoder().decode(bytes));
    if (p.throw !== false && res.status >= 400) {
      throw Object.assign(new Error(`Request failed, status ${res.status}`), {
        status: res.status,
        headers: outHeaders,
      });
    }
    return {
      status: res.status,
      headers: outHeaders,
      arrayBuffer: buf,
      get text(): string {
        return getText();
      },
      get json(): unknown {
        return JSON.parse(getText());
      },
    };
  };
  const promise = run() as RequestUrlResponsePromise;
  // Lazy getters: an eager `.then` chain per shortcut would raise unhandled rejections when the
  // request itself fails and the caller only awaited the main promise.
  for (const key of ["arrayBuffer", "json", "text"] as const) {
    void Object.defineProperty(promise, key, {
      get: () => promise.then((r) => r[key]),
      configurable: true,
    });
  }
  return promise;
}

export async function request(request: RequestUrlParam | string): Promise<string> {
  return (await requestUrl(request)).text;
}

// ---------------------------------------------------------------- fetch

/** Rust caps concurrent streams at 16 per window; wait client-side instead of failing. */
export const MAX_CONCURRENT_STREAMS = 16;
/** How long a request waits for a free stream slot before failing with a clear error. */
export const SLOT_WAIT_MS = 30_000;
/** Stream timeout (head + idle between chunks); Rust clamps to its 10 minute max. */
const STREAM_TIMEOUT_MS = 600_000;

const FALLTHROUGH_HOSTS = new Set([
  "ipc.localhost",
  "asset.localhost",
  "tauri.localhost",
  "writer-plugin.localhost",
]);
const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

let slotsInUse = 0;
const slotWaiters: (() => void)[] = [];

function releaseSlot(): void {
  const next = slotWaiters.shift();
  if (next)
    next(); // hand the slot over directly
  else slotsInUse = Math.max(0, slotsInUse - 1);
}

function acquireSlot(signal: AbortSignal | null): Promise<void> {
  if (slotsInUse < MAX_CONCURRENT_STREAMS) {
    slotsInUse++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const waiter = (): void => {
      cleanup();
      resolve();
    };
    const drop = (): void => {
      const i = slotWaiters.indexOf(waiter);
      if (i >= 0) slotWaiters.splice(i, 1);
    };
    const onAbort = (): void => {
      drop();
      cleanup();
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      drop();
      cleanup();
      reject(
        new TypeError(
          `Failed to fetch: too many concurrent plugin requests (limit ${MAX_CONCURRENT_STREAMS})`,
        ),
      );
    }, SLOT_WAIT_MS);
    slotWaiters.push(waiter);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortReason(signal: AbortSignal | null): unknown {
  if (signal && signal.reason !== undefined) return signal.reason;
  return new DOMException("The operation was aborted.", "AbortError");
}

/** The URL string if this request belongs to plugin networking, null to fall through. */
function externalUrl(input: string): string | null {
  let u: URL;
  try {
    const base = typeof location !== "undefined" ? location.href : undefined;
    u = new URL(input, base);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (FALLTHROUGH_HOSTS.has(u.hostname)) return null;
  if (typeof location !== "undefined" && location.origin && u.origin === location.origin)
    return null;
  return u.href;
}

function inputUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return (input as Request).url;
}

type FetchFn = typeof fetch;

let nativeFetch: FetchFn | undefined;

function callNative(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const f = nativeFetch ?? globalThis.fetch;
  return f.call(globalThis, input, init);
}

async function pluginFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const target = externalUrl(inputUrl(input));
  if (target === null) return callNative(input, init);
  const ipc = activeIpc;

  let req: Request;
  try {
    req = new Request(input instanceof URL ? input.href : input, init);
  } catch (e) {
    if (e instanceof TypeError) throw e;
    throw new TypeError(`Failed to fetch: ${errorText(e)}`);
  }
  const signal = req.signal;
  if (signal.aborted) throw abortReason(signal);

  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    headers[k] = v;
  });
  const wire: HttpRequestWire = {
    url: target,
    method: req.method,
    headers,
    timeout_ms: STREAM_TIMEOUT_MS,
    follow_redirects: req.redirect === "follow",
  };
  if (req.method !== "GET" && req.method !== "HEAD" && req.body !== null) {
    const bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes.length > 0) wire.body_base64 = bytesToBase64(bytes);
  }
  if (signal.aborted) throw abortReason(signal);

  await acquireSlot(signal);
  let slotHeld = true;
  const free = (): void => {
    if (slotHeld) {
      slotHeld = false;
      releaseSlot();
    }
  };

  return new Promise<Response>((resolve, reject) => {
    let streamId: number | null = null;
    let finished = false; // end / error / cancel / abort: no more events matter
    let headSeen = false;
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let wantsCancel = false;

    const cancelRemote = (): void => {
      if (streamId === null) {
        wantsCancel = true;
        return;
      }
      void ipc.streamCancel(streamId).catch(() => undefined);
    };
    const finish = (): void => {
      finished = true;
      signal.removeEventListener("abort", onAbort);
      free();
    };
    function onAbort(): void {
      if (finished) return;
      cancelRemote();
      finish();
      const reason = abortReason(signal);
      if (headSeen) {
        try {
          controller?.error(reason);
        } catch {
          // already closed
        }
      } else reject(reason);
    }
    signal.addEventListener("abort", onAbort, { once: true });

    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
      cancel() {
        if (finished) return;
        cancelRemote();
        finish();
      },
    });

    const onEvent = (ev: StreamEventWire): void => {
      if (finished) return;
      switch (ev.type) {
        case "head": {
          headSeen = true;
          if (req.redirect === "error" && ev.status >= 300 && ev.status < 400) {
            cancelRemote();
            finish();
            reject(new TypeError("Failed to fetch: unexpected redirect"));
            return;
          }
          const h = new Headers();
          for (const [k, v] of ev.headers) {
            try {
              h.append(k, v);
            } catch {
              // a header the page's Headers refuses: drop it
            }
          }
          const nullBody = NULL_BODY_STATUS.has(ev.status) || req.method === "HEAD";
          try {
            const res = new Response(nullBody ? null : body, {
              status: ev.status,
              headers: h,
            });
            Object.defineProperty(res, "url", { value: ev.url, configurable: true });
            Object.defineProperty(res, "redirected", {
              value: ev.url !== target,
              configurable: true,
            });
            resolve(res);
          } catch (e) {
            cancelRemote();
            finish();
            reject(new TypeError(`Failed to fetch: ${errorText(e)}`));
          }
          return;
        }
        case "chunk":
          try {
            controller?.enqueue(base64ToBytes(ev.data_base64));
          } catch {
            // consumer cancelled
          }
          return;
        case "end":
          finish();
          try {
            controller?.close();
          } catch {
            // already closed
          }
          return;
        case "error": {
          finish();
          const err = new TypeError(`Failed to fetch: ${ev.message}`);
          if (headSeen) {
            try {
              controller?.error(err);
            } catch {
              // already closed
            }
          } else reject(err);
          return;
        }
      }
    };

    ipc.streamStart(wire, onEvent).then(
      (id) => {
        streamId = id;
        if (wantsCancel || finished) {
          // aborted (or cancelled) while the start call was in flight
          void ipc.streamCancel(id).catch(() => undefined);
        }
      },
      (e: unknown) => {
        if (finished) return;
        finish();
        reject(new TypeError(`Failed to fetch: ${errorText(e)}`));
      },
    );
  });
}

/** The plugin-scoped fetch. Marked so install can recognise it. */
export const pluginScopedFetch: FetchFn = Object.assign(pluginFetch, {
  __writerPluginFetch: true,
}) as FetchFn;

// ---------------------------------------------------------------- global patch

function isPatched(f: unknown): boolean {
  return (
    typeof f === "function" && (f as { __writerPluginFetch?: boolean }).__writerPluginFetch === true
  );
}

/**
 * Replaces `globalThis.fetch` / `window.fetch` with the plugin-scoped fetch (bundled SDKs capture
 * the global). Idempotent: a second call while installed is a no-op returning a no-op uninstall.
 * The returned function restores the original, and only if nobody wrapped ours since.
 */
export function installGlobalFetch(): () => void {
  const g = globalThis as { fetch?: unknown; window?: { fetch?: unknown } };
  if (isPatched(g.fetch) || typeof g.fetch !== "function") return () => undefined;
  const original = g.fetch as FetchFn;
  nativeFetch = original;
  g.fetch = pluginScopedFetch;
  const w = typeof window !== "undefined" ? (window as { fetch?: unknown }) : undefined;
  if (w && w !== (g as unknown) && w.fetch === original) w.fetch = pluginScopedFetch;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (g.fetch === pluginScopedFetch) g.fetch = original;
    if (w && w !== (g as unknown) && w.fetch === pluginScopedFetch) w.fetch = original;
    if (nativeFetch === original) nativeFetch = undefined;
  };
}
