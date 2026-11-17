// `http` / `https`.
//   createServer().listen(): fails ASYNCHRONOUSLY with an EPERM-style 'error' event (a WKWebView
//   cannot listen); it neither throws nor hangs, so callers like loopback MCP servers degrade.
//   request()/get(): a minimal client over the global (plugin-scoped) fetch: buffered request
//   body, streamed response body, no agents/sockets/upgrade/redirect following.
import { Buffer } from "./buffer";
import { abortError, messageOf, nodeError, type NodeError } from "./errors";
import { EventEmitter } from "./events";
import { Readable, Writable } from "./stream";

const LISTEN_MESSAGE =
  "listen EPERM: operation not permitted (HTTP servers are not available in Writer)";

export class Server extends EventEmitter {
  listening = false;
  constructor(...args: unknown[]) {
    super();
    const handler = args.find((a) => typeof a === "function") as
      | ((...a: unknown[]) => void)
      | undefined;
    if (handler) this.on("request", handler);
  }
  listen(...args: unknown[]): this {
    const cb = args.find((a) => typeof a === "function") as (() => void) | undefined;
    void cb; // never called: the server never listens
    const port = typeof args[0] === "number" ? args[0] : undefined;
    const err = nodeError("EPERM", LISTEN_MESSAGE, {
      errno: -1,
      syscall: "listen",
      address: typeof args[1] === "string" ? args[1] : "127.0.0.1",
      port,
    });
    queueMicrotask(() => {
      if (this.listenerCount("error") > 0) this.emit("error", err);
      else console.warn(`[plugin] ${err.message}`);
    });
    return this;
  }
  close(cb?: (err?: Error) => void): this {
    const err = nodeError("ERR_SERVER_NOT_RUNNING", "Server is not running.");
    queueMicrotask(() => {
      cb?.(err);
      this.emit("close");
    });
    return this;
  }
  address(): null {
    return null;
  }
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
  setTimeout(): this {
    return this;
  }
  closeAllConnections(): void {}
  closeIdleConnections(): void {}
}

export class IncomingMessage extends Readable {
  statusCode = 0;
  statusMessage = "";
  httpVersion = "1.1";
  headers: Record<string, string | string[]> = {};
  rawHeaders: string[] = [];
  url = "";
  method: string | null = null;
  complete = false;
  setTimeout(): this {
    return this;
  }
}

type Headers = Record<string, string | number | readonly string[]>;
interface RequestOptions {
  protocol?: string;
  hostname?: string;
  host?: string;
  port?: number | string;
  path?: string;
  method?: string;
  headers?: Headers;
  signal?: AbortSignal;
  timeout?: number;
  auth?: string;
  [k: string]: unknown;
}

export class ClientRequest extends Writable {
  method: string;
  path: string;
  host: string;
  protocol: string;
  aborted = false;
  private readonly headers = new Map<string, { name: string; value: string }>();
  private readonly chunks: Buffer[] = [];
  private readonly controller = new AbortController();
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly url: URL,
    options: RequestOptions,
    cb?: (res: IncomingMessage) => void,
  ) {
    super();
    this.method = (options.method ?? "GET").toUpperCase();
    this.path = `${url.pathname}${url.search}`;
    this.host = url.hostname;
    this.protocol = url.protocol;
    for (const [k, v] of Object.entries(options.headers ?? {})) this.setHeader(k, v);
    if (options.auth)
      this.setHeader("authorization", `Basic ${Buffer.from(options.auth).toString("base64")}`);
    if (cb) this.once("response", cb);
    if (options.timeout) this.setTimeout(options.timeout);
    const signal = options.signal;
    if (signal) {
      const onAbort = (): void => void this.destroy(abortError());
      if (signal.aborted) queueMicrotask(onAbort);
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  setHeader(name: string, value: string | number | readonly string[]): this {
    this.headers.set(name.toLowerCase(), {
      name,
      value: Array.isArray(value) ? value.join(", ") : String(value),
    });
    return this;
  }
  getHeader(name: string): string | undefined {
    return this.headers.get(name.toLowerCase())?.value;
  }
  hasHeader(name: string): boolean {
    return this.headers.has(name.toLowerCase());
  }
  removeHeader(name: string): void {
    this.headers.delete(name.toLowerCase());
  }
  getHeaders(): Record<string, string> {
    return Object.fromEntries([...this.headers].map(([k, v]) => [k, v.value]));
  }
  setTimeout(ms: number, cb?: () => void): this {
    if (cb) this.once("timeout", cb);
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    if (ms > 0) this.timeoutTimer = setTimeout(() => this.emit("timeout"), ms);
    return this;
  }
  setNoDelay(): void {}
  setSocketKeepAlive(): void {}
  flushHeaders(): void {}
  abort(): void {
    this.aborted = true;
    this.destroy(abortError());
  }

  override _write(chunk: unknown, _enc: string, cb: (e?: Error | null) => void): void {
    this.chunks.push(chunk as Buffer);
    cb();
  }
  override _final(cb: (e?: Error | null) => void): void {
    void this.send();
    cb();
  }
  protected override _destroy(err: Error | null, cb: (e?: Error | null) => void): void {
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    this.controller.abort();
    cb(err);
  }

  private async send(): Promise<void> {
    const body = this.chunks.length > 0 ? Buffer.concat(this.chunks) : undefined;
    const headers = new globalThis.Headers();
    for (const { name, value } of this.headers.values()) headers.set(name, value);
    try {
      const res = await globalThis.fetch(this.url.href, {
        method: this.method,
        headers,
        body: this.method === "GET" || this.method === "HEAD" ? undefined : body,
        redirect: "manual",
        signal: this.controller.signal,
      });
      if (this.destroyed) return;
      if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
      const msg = new IncomingMessage();
      msg.statusCode = res.status;
      msg.statusMessage = res.statusText || STATUS_CODES[res.status] || "";
      res.headers.forEach((v, k) => {
        msg.rawHeaders.push(k, v);
        if (k !== "set-cookie") msg.headers[k] = v;
      });
      const cookies = (res.headers as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
      if (cookies.length > 0) msg.headers["set-cookie"] = cookies;
      this.emit("response", msg);
      if (!res.body) {
        msg.complete = true;
        msg.push(null);
        return;
      }
      const reader = res.body.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        msg.push(Buffer.from(value.buffer as ArrayBuffer, value.byteOffset, value.byteLength));
      }
      msg.complete = true;
      msg.push(null);
    } catch (e) {
      if (this.destroyed) return;
      const err = e as NodeError;
      const wrapped: NodeError =
        err?.name === "AbortError"
          ? err
          : nodeError("ECONNRESET", `request failed: ${messageOf(e)}`);
      this.destroy(wrapped);
    }
  }
}

export const STATUS_CODES: Record<number, string> = {
  200: "OK",
  201: "Created",
  202: "Accepted",
  204: "No Content",
  301: "Moved Permanently",
  302: "Found",
  304: "Not Modified",
  307: "Temporary Redirect",
  308: "Permanent Redirect",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  408: "Request Timeout",
  409: "Conflict",
  413: "Payload Too Large",
  415: "Unsupported Media Type",
  422: "Unprocessable Entity",
  429: "Too Many Requests",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

class Agent {
  constructor(readonly options: unknown = {}) {}
  destroy(): void {}
}

export function createHttpModule(defaultProtocol: "http:" | "https:") {
  function request(
    input: string | URL | RequestOptions,
    optionsOrCb?: RequestOptions | ((res: IncomingMessage) => void),
    maybeCb?: (res: IncomingMessage) => void,
  ): ClientRequest {
    const cb = typeof optionsOrCb === "function" ? optionsOrCb : maybeCb;
    let options: RequestOptions = typeof optionsOrCb === "object" && optionsOrCb ? optionsOrCb : {};
    let url: URL;
    if (typeof input === "string" || input instanceof URL) url = new URL(String(input));
    else {
      options = { ...input, ...options };
      const proto = options.protocol ?? defaultProtocol;
      const host = options.hostname ?? options.host ?? "localhost";
      url = new URL(
        `${proto}//${host}${options.port ? `:${options.port}` : ""}${options.path ?? "/"}`,
      );
    }
    if (url.protocol !== defaultProtocol)
      throw nodeError(
        "ERR_INVALID_PROTOCOL",
        `Protocol "${url.protocol}" not supported. Expected "${defaultProtocol}"`,
      );
    return new ClientRequest(url, options, cb);
  }
  return {
    createServer: (...args: unknown[]): Server => new Server(...args),
    request,
    get(...args: Parameters<typeof request>): ClientRequest {
      const req = request(...args);
      req.end();
      return req;
    },
    Server,
    ClientRequest,
    IncomingMessage,
    Agent,
    globalAgent: new Agent(),
    STATUS_CODES,
    METHODS: ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"],
  };
}
