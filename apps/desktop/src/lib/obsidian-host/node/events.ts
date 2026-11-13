// `events`: a Node-compatible EventEmitter (class form; ES5 `EventEmitter.call(this)` is not
// supported, `class X extends EventEmitter` and util.inherits-free code are).
import { nodeError } from "./errors";

export type Listener = (...args: any[]) => unknown;
type Key = string | symbol;
interface Entry {
  fn: Listener;
  once: boolean;
}

export interface EventEmitterOptions {
  captureRejections?: boolean;
}

export class EventEmitter {
  static defaultMaxListeners = 10;
  static readonly errorMonitor = Symbol("events.errorMonitor");
  static readonly captureRejectionSymbol = Symbol.for("nodejs.rejection");
  static EventEmitter: typeof EventEmitter;

  private _events = new Map<Key, Entry[]>();
  private _maxListeners: number | undefined;
  private _captureRejections: boolean;

  constructor(options?: EventEmitterOptions) {
    this._captureRejections = options?.captureRejections === true;
  }

  private add(name: Key, fn: Listener, once: boolean, prepend: boolean): this {
    if (typeof fn !== "function")
      throw nodeError(
        "ERR_INVALID_ARG_TYPE",
        `The "listener" argument must be of type function. Received ${typeof fn}`,
      );
    // Node emits 'newListener' first, before the listener is added.
    if (this._events.has("newListener")) this.emit("newListener", name, fn);
    const list = this._events.get(name) ?? [];
    const entry = { fn, once };
    if (prepend) list.unshift(entry);
    else list.push(entry);
    this._events.set(name, list);
    this._listenerAdded(name);
    return this;
  }

  /** Hook for subclasses (streams start flowing when a 'data' listener appears). */
  protected _listenerAdded(_name: Key): void {}

  on(name: Key, fn: Listener): this {
    return this.add(name, fn, false, false);
  }
  addListener(name: Key, fn: Listener): this {
    return this.add(name, fn, false, false);
  }
  once(name: Key, fn: Listener): this {
    return this.add(name, fn, true, false);
  }
  prependListener(name: Key, fn: Listener): this {
    return this.add(name, fn, false, true);
  }
  prependOnceListener(name: Key, fn: Listener): this {
    return this.add(name, fn, true, true);
  }

  off(name: Key, fn: Listener): this {
    return this.removeListener(name, fn);
  }
  removeListener(name: Key, fn: Listener): this {
    const list = this._events.get(name);
    if (!list) return this;
    // Node removes the most recently added matching listener.
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].fn === fn) {
        list.splice(i, 1);
        if (list.length === 0) this._events.delete(name);
        if (this._events.has("removeListener")) this.emit("removeListener", name, fn);
        break;
      }
    }
    return this;
  }
  removeAllListeners(name?: Key): this {
    if (name === undefined) this._events.clear();
    else this._events.delete(name);
    return this;
  }

  emit(name: Key, ...args: any[]): boolean {
    const list = this._events.get(name);
    if (name === "error" && !list) {
      const monitor = this._events.get(EventEmitter.errorMonitor);
      if (monitor) for (const e of [...monitor]) e.fn.apply(this, args);
      const err = args[0];
      if (err instanceof Error) throw err;
      throw nodeError("ERR_UNHANDLED_ERROR", `Unhandled error. (${String(err)})`, { context: err });
    }
    if (!list) return false;
    for (const entry of [...list]) {
      if (entry.once) this.removeListener(name, entry.fn);
      const result = entry.fn.apply(this, args);
      if (
        this._captureRejections &&
        result &&
        typeof (result as Promise<unknown>).then === "function"
      ) {
        (result as Promise<unknown>).then(undefined, (err: unknown) => {
          const custom = (this as any)[EventEmitter.captureRejectionSymbol];
          if (typeof custom === "function") custom.call(this, err, name, ...args);
          else if (name !== "error") this.emit("error", err);
          else
            queueMicrotask(() => {
              throw err;
            });
        });
      }
    }
    return true;
  }

  listenerCount(name: Key, fn?: Listener): number {
    const list = this._events.get(name);
    if (!list) return 0;
    return fn ? list.filter((e) => e.fn === fn).length : list.length;
  }
  listeners(name: Key): Listener[] {
    return (this._events.get(name) ?? []).map((e) => e.fn);
  }
  rawListeners(name: Key): Listener[] {
    return this.listeners(name);
  }
  eventNames(): Key[] {
    return [...this._events.keys()];
  }
  setMaxListeners(n: number): this {
    this._maxListeners = n;
    return this;
  }
  getMaxListeners(): number {
    return this._maxListeners ?? EventEmitter.defaultMaxListeners;
  }

  /** `events.once(emitter, name)`: resolves with the args; rejects on 'error' (unless name is 'error'). */
  static once(emitter: EventEmitter, name: Key, opts?: { signal?: AbortSignal }): Promise<any[]> {
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        emitter.removeListener(name, onEvent);
        emitter.removeListener("error", onError);
        opts?.signal?.removeEventListener("abort", onAbort);
      };
      const onEvent = (...args: unknown[]): void => {
        cleanup();
        resolve(args);
      };
      const onError = (err: unknown): void => {
        cleanup();
        reject(err);
      };
      const onAbort = (): void => {
        cleanup();
        reject(nodeError("ABORT_ERR", "The operation was aborted", { name: "AbortError" }));
      };
      emitter.on(name, onEvent);
      if (name !== "error") emitter.on("error", onError);
      opts?.signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** `events.setMaxListeners(n, ...targets)`: sets the default when no target is given. */
  static setMaxListeners(
    n: number,
    ...targets: Array<{ setMaxListeners?: (n: number) => unknown }>
  ): void {
    if (targets.length === 0) EventEmitter.defaultMaxListeners = n;
    for (const t of targets) t.setMaxListeners?.(n);
  }
  static getMaxListeners(emitter: EventEmitter): number {
    return emitter.getMaxListeners();
  }

  /** `events.on(emitter, name)`: async iterator over the emitted arg arrays; ends on `signal` abort. */
  static on(
    emitter: EventEmitter,
    name: Key,
    opts?: { signal?: AbortSignal },
  ): AsyncIterableIterator<any[]> {
    const queue: any[][] = [];
    let error: unknown = null;
    let done = false;
    let wake: (() => void) | null = null;
    const onEvent = (...args: any[]): void => {
      queue.push(args);
      wake?.();
    };
    const onError = (err: unknown): void => {
      error = err;
      wake?.();
    };
    const onAbort = (): void => {
      error = nodeError("ABORT_ERR", "The operation was aborted", { name: "AbortError" });
      wake?.();
    };
    emitter.on(name, onEvent);
    if (name !== "error") emitter.on("error", onError);
    opts?.signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = (): void => {
      done = true;
      emitter.removeListener(name, onEvent);
      emitter.removeListener("error", onError);
      opts?.signal?.removeEventListener("abort", onAbort);
    };
    return {
      async next() {
        for (;;) {
          if (queue.length > 0) return { value: queue.shift()!, done: false };
          if (error) {
            const e = error;
            error = null;
            cleanup();
            throw e;
          }
          if (done) return { value: undefined, done: true };
          await new Promise<void>((r) => (wake = r));
          wake = null;
        }
      },
      async return() {
        cleanup();
        return { value: undefined, done: true };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  }

  static listenerCount(emitter: EventEmitter, name: Key): number {
    return emitter.listenerCount(name);
  }
}
EventEmitter.EventEmitter = EventEmitter;

export default EventEmitter;
