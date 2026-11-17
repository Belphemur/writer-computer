// In-thread stand-in for `new Worker(URL.createObjectURL(blob))`.
//
// Why: the app CSP has no `blob:` in `script-src`/`worker-src`, so the webview refuses blob
// workers, and Dataview builds exactly that (its indexer is an inlined worker started in
// `onload`; without it the plugin never indexes and every query stays empty). Widening the CSP
// for every page was not an option (see the eval ADR), so a blob worker is run on the main
// thread instead: the script is evaluated in a function scope that provides `postMessage`, the
// `onmessage` slot and a `self`, and messages are delivered asynchronously (timer) through
// `structuredClone`, which keeps the real worker's copy semantics (a worker that mutates its
// input must not mutate the host's metadata cache).
//
// Only blob workers created while plugins are loaded are intercepted; anything else goes to the
// real `Worker` when there is one. Cost: the parse runs on the UI thread, one file per timer
// tick, so input and paint stay interleaved.

type Listener = (evt: unknown) => void;

const blobs = new Map<string, Blob>();
const BLOBS_MAX = 64;

function readText(blob: Blob): Promise<string> {
  if (typeof blob.text === "function") return blob.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("could not read worker script"));
    reader.readAsText(blob);
  });
}

const clone = <T>(value: T): T =>
  typeof structuredClone === "function" ? structuredClone(value) : (value as T);

/** The class installed as `Worker`; exported for tests. */
export class InThreadWorker {
  onmessage: Listener | null = null;
  onerror: Listener | null = null;
  private listeners = { message: new Set<Listener>(), error: new Set<Listener>() };
  private inbox: unknown[] = [];
  private handler: ((evt: { data: unknown }) => unknown) | null = null;
  private terminated = false;
  private starting: Promise<void>;
  private draining = false;

  constructor(url: string | URL, _options?: unknown) {
    const blob = blobs.get(String(url));
    if (!blob) throw new Error(`Worker: ${String(url)} is not a blob created by a plugin`);
    this.starting = readText(blob).then(
      (code) => this.boot(code),
      (e) => this.fail(e),
    );
  }

  private boot(code: string): void {
    if (this.terminated) return;
    const scope: Record<string, unknown> = {
      // `self.onmessage = fn` (Excalidraw's LZ-string worker) and `self.addEventListener("message", fn)`
      // reach the handler like the bare `onmessage = fn` of Dataview's worker.
      onmessage: null,
      addEventListener: (type: string, fn: unknown) => {
        if (type === "message" && typeof fn === "function") scope.onmessage = fn;
      },
      removeEventListener: () => {},
      postMessage: (data: unknown) => this.deliver("message", { data: clone(data) }),
      close: () => this.terminate(),
      importScripts: () => {
        throw new Error("importScripts is not available in a Writer plugin worker");
      },
    };
    try {
      // `var onmessage` is the worker global's handler slot; the script assigns it.
      const run = new Function(
        "self",
        "postMessage",
        "close",
        "importScripts",
        `var onmessage;\n${code}\n;return function () { return onmessage; };`,
      );
      const read = run(scope, scope.postMessage, scope.close, scope.importScripts) as () => unknown;
      const bare = read();
      const h = typeof bare === "function" ? bare : scope.onmessage;
      this.handler = typeof h === "function" ? (h as (evt: { data: unknown }) => unknown) : null;
    } catch (e) {
      this.fail(e);
    }
  }

  private fail(e: unknown): void {
    console.error("[plugin] in-thread worker failed to start:", e);
    this.deliver("error", { message: e instanceof Error ? e.message : String(e), error: e });
  }

  private deliver(kind: "message" | "error", evt: unknown): void {
    setTimeout(() => {
      if (this.terminated) return;
      const direct = kind === "message" ? this.onmessage : this.onerror;
      direct?.(evt);
      for (const l of Array.from(this.listeners[kind])) l(evt);
    }, 0);
  }

  postMessage(data: unknown): void {
    if (this.terminated) return;
    this.inbox.push(clone(data));
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      await this.starting;
      while (this.inbox.length > 0 && !this.terminated) {
        const data = this.inbox.shift();
        // One message per tick: the UI thread gets a turn between files.
        await new Promise<void>((r) => setTimeout(r, 0));
        try {
          await this.handler?.({ data });
        } catch (e) {
          console.error("[plugin] in-thread worker handler threw:", e);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  addEventListener(type: string, listener: Listener): void {
    if (type === "message" || type === "error") this.listeners[type].add(listener);
  }
  removeEventListener(type: string, listener: Listener): void {
    if (type === "message" || type === "error") this.listeners[type].delete(listener);
  }
  terminate(): void {
    this.terminated = true;
    this.inbox.length = 0;
  }
}

/** Installs the shim on `target` (default `globalThis`); returns the uninstall function. */
export function installInThreadWorkers(target: typeof globalThis = globalThis): () => void {
  const urlApi = target.URL;
  if (!urlApi || typeof urlApi.createObjectURL !== "function") return () => {};
  const originalCreate = urlApi.createObjectURL;
  const originalRevoke = urlApi.revokeObjectURL;
  const RealWorker = (target as { Worker?: typeof Worker }).Worker;

  urlApi.createObjectURL = function (obj: Blob | MediaSource): string {
    const url = originalCreate.call(urlApi, obj);
    if (typeof Blob !== "undefined" && obj instanceof Blob) {
      blobs.set(url, obj);
      if (blobs.size > BLOBS_MAX) blobs.delete(blobs.keys().next().value as string);
    }
    return url;
  };
  // Dataview never revokes; a plugin that does must not break a worker that already booted.
  urlApi.revokeObjectURL = function (url: string): void {
    originalRevoke?.call(urlApi, url);
  };

  const Shim = function (url: string | URL, options?: WorkerOptions): Worker {
    if (blobs.has(String(url))) return new InThreadWorker(url, options) as unknown as Worker;
    if (RealWorker) return new RealWorker(url, options);
    throw new Error("Worker is not available");
  } as unknown as typeof Worker;
  (target as { Worker?: unknown }).Worker = Shim;

  return () => {
    urlApi.createObjectURL = originalCreate;
    urlApi.revokeObjectURL = originalRevoke;
    (target as { Worker?: unknown }).Worker = RealWorker;
  };
}
