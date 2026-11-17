// `stream`: classic Node streams (Readable, Writable, Duplex, Transform, PassThrough, pipeline,
// finished, promises, toWeb/fromWeb). Scheduling uses microtasks. Readable has no hard
// backpressure from the producer side (Rust channel events are push-only): `push()` returns false
// past the high-water mark but data is always buffered. Writable serializes writes in order and
// honours the high-water mark with 'drain'.
import { Buffer } from "./buffer";
import { nodeError } from "./errors";
import { EventEmitter } from "./events";
import { StringDecoder } from "./string-decoder";

const schedule = (fn: () => void): void => queueMicrotask(fn);
type Cb = (err?: Error | null) => void;

const errPrematureClose = (): Error => nodeError("ERR_STREAM_PREMATURE_CLOSE", "Premature close");

/** Legacy base class: `require("stream")` is this class with the others attached. */
export class Stream extends EventEmitter {}

/** What `pipe()` needs from a destination (Duplex shares these without being a Writable subclass). */
export interface WritableLike {
  write(chunk: any, encoding?: any, cb?: any): boolean;
  end(...args: any[]): unknown;
  once(name: string | symbol, fn: (...args: any[]) => unknown): unknown;
  emit(name: string | symbol, ...args: any[]): boolean;
}

interface ReadableState {
  buf: unknown[];
  length: number;
  flowing: boolean | null;
  ended: boolean;
  endEmitted: boolean;
  objectMode: boolean;
  hwm: number;
  decoder: StringDecoder | null;
  encoding: string | null;
  reading: boolean;
  flowScheduled: boolean;
  readableListening: boolean;
  readableEmitted: boolean;
  autoDestroy: boolean;
  pipes: { dest: WritableLike; onData: (c: unknown) => void; onEnd: () => void }[];
}

interface WriteItem {
  chunk: unknown;
  enc: string;
  cb?: Cb;
  len: number;
}
interface WritableState {
  queue: WriteItem[];
  writing: boolean;
  length: number;
  hwm: number;
  ending: boolean;
  finalCalled: boolean;
  finished: boolean;
  needDrain: boolean;
  objectMode: boolean;
  decodeStrings: boolean;
  defaultEncoding: string;
  corked: number;
  autoDestroy: boolean;
}

export interface StreamOptions {
  highWaterMark?: number;
  objectMode?: boolean;
  encoding?: string;
  autoDestroy?: boolean;
  decodeStrings?: boolean;
  defaultEncoding?: string;
  read?: (this: Readable, size: number) => void;
  write?: (this: Writable, chunk: any, encoding: string, cb: Cb) => void;
  final?: (this: Writable, cb: Cb) => void;
  destroy?: (this: StreamBase, err: Error | null, cb: Cb) => void;
  transform?: (
    this: Transform,
    chunk: any,
    encoding: string,
    cb: (err?: Error | null, data?: unknown) => void,
  ) => void;
  flush?: (this: Transform, cb: (err?: Error | null, data?: unknown) => void) => void;
}

export class StreamBase extends Stream {
  destroyed = false;
  closed = false;
  errored: Error | null = null;
  _rs?: ReadableState;
  _ws?: WritableState;

  protected _destroy(err: Error | null, cb: Cb): void {
    cb(err);
  }
  protected _onDestroy(_err: Error | null): void {}

  destroy(err?: Error | null): this {
    if (this.destroyed) return this;
    this.destroyed = true;
    if (err) this.errored = err;
    this._onDestroy(err ?? null);
    this._destroy(err ?? null, (e) => {
      schedule(() => {
        if (e) this.emit("error", e);
        this.closed = true;
        this.emit("close");
      });
    });
    return this;
  }
}

// ---------------------------------------------------------------- Readable

export class Readable extends StreamBase {
  constructor(options: StreamOptions = {}) {
    super();
    const objectMode = options.objectMode === true;
    this._rs = {
      buf: [],
      length: 0,
      flowing: null,
      ended: false,
      endEmitted: false,
      objectMode,
      hwm: options.highWaterMark ?? (objectMode ? 16 : 16384),
      decoder: null,
      encoding: null,
      reading: false,
      flowScheduled: false,
      readableListening: false,
      readableEmitted: false,
      autoDestroy: options.autoDestroy !== false,
      pipes: [],
    };
    if (options.encoding) this.setEncoding(options.encoding);
    if (options.read) this._read = options.read;
    if (options.destroy) this._destroy = options.destroy as never;
  }

  private get rs(): ReadableState {
    return this._rs!;
  }

  get readable(): boolean {
    return !this.destroyed && !this.rs.endEmitted && !this.rs.ended;
  }
  get readableFlowing(): boolean | null {
    return this.rs.flowing;
  }
  get readableEnded(): boolean {
    return this.rs.endEmitted;
  }
  get readableLength(): number {
    return this.rs.length;
  }
  get readableHighWaterMark(): number {
    return this.rs.hwm;
  }
  get readableObjectMode(): boolean {
    return this.rs.objectMode;
  }
  get readableEncoding(): string | null {
    return this.rs.encoding;
  }

  _read(_size: number): void {}

  push(chunk: unknown, encoding?: string): boolean {
    const rs = this.rs;
    if (chunk === null) {
      rs.ended = true;
      rs.reading = false;
      this.scheduleFlow();
      return false;
    }
    if (rs.ended) {
      this.destroy(nodeError("ERR_STREAM_PUSH_AFTER_EOF", "stream.push() after EOF"));
      return false;
    }
    if (this.destroyed) return false;
    rs.reading = false;
    let c: unknown = chunk;
    if (!rs.objectMode) {
      if (typeof c === "string") {
        if (rs.decoder && (encoding === undefined || encoding === rs.encoding)) {
          // keep as string
        } else c = Buffer.from(c, encoding);
      }
      if (c instanceof Uint8Array && !(c instanceof Buffer))
        c = Buffer.from(c.buffer as ArrayBuffer, c.byteOffset, c.byteLength);
      if (rs.decoder && c instanceof Uint8Array) c = rs.decoder.write(c);
      if ((c as { length: number }).length === 0) {
        this.scheduleFlow();
        return rs.length < rs.hwm;
      }
    }
    rs.buf.push(c);
    rs.length += rs.objectMode ? 1 : (c as { length: number }).length;
    this.scheduleFlow();
    return rs.length < rs.hwm;
  }

  unshift(chunk: unknown): void {
    const rs = this.rs;
    const c = typeof chunk === "string" && !rs.objectMode ? Buffer.from(chunk) : chunk;
    rs.buf.unshift(c);
    rs.length += rs.objectMode ? 1 : (c as { length: number }).length;
  }

  private scheduleFlow(): void {
    const rs = this.rs;
    if (rs.flowScheduled) return;
    rs.flowScheduled = true;
    schedule(() => {
      rs.flowScheduled = false;
      this.flow();
    });
  }

  private take(): unknown {
    const rs = this.rs;
    const c = rs.buf.shift();
    rs.length -= rs.objectMode ? 1 : (c as { length: number }).length;
    return c;
  }

  private flow(): void {
    const rs = this.rs;
    if (this.destroyed) return;
    if (rs.flowing === true) {
      while (rs.buf.length > 0 && rs.flowing === true && !this.destroyed)
        this.emit("data", this.take());
      if (this.destroyed) return;
      if (rs.buf.length === 0 && !rs.ended && rs.flowing === true && !rs.reading) {
        rs.reading = true;
        this._read(rs.hwm);
      }
      if (rs.ended && rs.buf.length === 0 && rs.flowing === true) this.emitEnd();
    } else if (rs.readableListening) {
      if (rs.buf.length > 0 || rs.ended) this.emit("readable");
      if (rs.ended && rs.buf.length === 0) this.emitEnd();
    }
  }

  private emitEnd(): void {
    const rs = this.rs;
    if (rs.endEmitted || this.destroyed) return;
    if (rs.decoder) {
      const tail = rs.decoder.end();
      if (tail) {
        rs.buf.push(tail);
        rs.length += tail.length;
        this.scheduleFlow();
        return;
      }
    }
    rs.endEmitted = true;
    this.emit("end");
    if (rs.autoDestroy)
      schedule(() => {
        if (!this._ws || this._ws.finished) this.destroy();
      });
  }

  protected override _listenerAdded(name: string | symbol): void {
    const rs = this._rs;
    if (!rs) return;
    if (name === "data") {
      if (rs.flowing !== false) this.resume();
    } else if (name === "readable") {
      rs.readableListening = true;
      rs.flowing = false;
      this.scheduleFlow();
    }
  }

  read(size?: number): unknown {
    const rs = this.rs;
    if (!rs.ended && !rs.reading && rs.length < rs.hwm) {
      rs.reading = true;
      this._read(rs.hwm);
    }
    if (rs.buf.length === 0) {
      if (rs.ended) schedule(() => this.emitEnd());
      return null;
    }
    if (rs.objectMode) return this.take();
    const strings = typeof rs.buf[0] === "string";
    const joined: any = strings ? (rs.buf as string[]).join("") : Buffer.concat(rs.buf as Buffer[]);
    if (size !== undefined && size < joined.length) {
      const head = joined.slice(0, size);
      rs.buf = [joined.slice(size)];
      rs.length = joined.length - size;
      return head;
    }
    rs.buf = [];
    rs.length = 0;
    return joined;
  }

  resume(): this {
    this.rs.flowing = true;
    this.scheduleFlow();
    return this;
  }
  pause(): this {
    if (this.rs.flowing !== false) {
      this.rs.flowing = false;
      this.emit("pause");
    }
    return this;
  }
  isPaused(): boolean {
    return this.rs.flowing === false;
  }

  setEncoding(encoding: string): this {
    const rs = this.rs;
    rs.decoder = new StringDecoder(encoding);
    rs.encoding = rs.decoder.encoding;
    rs.buf = rs.buf.map((c) => (c instanceof Uint8Array ? rs.decoder!.write(c) : c));
    rs.length = rs.buf.reduce<number>((n, c) => n + (c as { length: number }).length, 0);
    return this;
  }

  pipe<T extends WritableLike>(dest: T, options?: { end?: boolean }): T {
    const rs = this.rs;
    let waiting = false;
    const onData = (c: unknown): void => {
      if (dest.write(c) === false && !waiting) {
        waiting = true;
        this.pause();
        dest.once("drain", () => {
          waiting = false;
          this.resume();
        });
      }
    };
    const onEnd = (): void => {
      if (options?.end !== false) dest.end();
    };
    rs.pipes.push({ dest, onData, onEnd });
    this.on("data", onData);
    this.once("end", onEnd);
    dest.once("close", () => this.unpipe(dest));
    dest.emit("pipe", this);
    return dest;
  }

  unpipe(dest?: WritableLike): this {
    const rs = this.rs;
    for (const p of rs.pipes.slice()) {
      if (dest && p.dest !== dest) continue;
      this.removeListener("data", p.onData);
      this.removeListener("end", p.onEnd);
      rs.pipes.splice(rs.pipes.indexOf(p), 1);
      p.dest.emit("unpipe", this);
    }
    return this;
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<any> {
    const queue: unknown[] = [];
    let done = false;
    let error: unknown = null;
    let wake: (() => void) | null = null;
    const poke = (): void => wake?.();
    const onData = (c: unknown): void => {
      queue.push(c);
      poke();
    };
    const onEnd = (): void => {
      done = true;
      poke();
    };
    const onError = (e: unknown): void => {
      error = e;
      poke();
    };
    this.on("data", onData);
    this.on("end", onEnd);
    this.on("close", onEnd);
    this.on("error", onError);
    const cleanup = (): void => {
      this.removeListener("data", onData);
      this.removeListener("end", onEnd);
      this.removeListener("close", onEnd);
      this.removeListener("error", onError);
    };
    const destroyStream = (): void => void this.destroy();
    return {
      async next(): Promise<IteratorResult<any>> {
        for (;;) {
          if (queue.length > 0) return { value: queue.shift(), done: false };
          if (error) {
            const e = error;
            error = null;
            cleanup();
            throw e;
          }
          if (done) {
            cleanup();
            return { value: undefined, done: true };
          }
          await new Promise<void>((r) => (wake = r));
          wake = null;
        }
      },
      async return(): Promise<IteratorResult<any>> {
        cleanup();
        destroyStream();
        return { value: undefined, done: true };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  }

  static from(
    iterable: Iterable<unknown> | AsyncIterable<unknown>,
    options: StreamOptions = {},
  ): Readable {
    if (typeof iterable === "string" || iterable instanceof Uint8Array)
      iterable = [iterable] as Iterable<unknown>;
    const it: Iterator<unknown> | AsyncIterator<unknown> =
      (iterable as AsyncIterable<unknown>)[Symbol.asyncIterator]?.() ??
      (iterable as Iterable<unknown>)[Symbol.iterator]();
    let running = false;
    return new Readable({
      objectMode: true,
      ...options,
      read() {
        if (running) return;
        running = true;
        void (async () => {
          try {
            for (;;) {
              const r = await it.next();
              if (r.done) {
                this.push(null);
                break;
              }
              if (!this.push(r.value)) break;
            }
          } catch (e) {
            this.destroy(e as Error);
          }
          running = false;
        })();
      },
      destroy(err, cb) {
        void (it as { return?: () => unknown }).return?.();
        cb(err);
      },
    });
  }

  static toWeb(r: Readable): ReadableStream<any> {
    let controller!: ReadableStreamDefaultController<any>;
    return new ReadableStream<any>({
      start(c) {
        controller = c;
        r.on("data", (chunk: unknown) => {
          controller.enqueue(
            chunk instanceof Uint8Array
              ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
              : chunk,
          );
          if (controller.desiredSize !== null && controller.desiredSize <= 0) r.pause();
        });
        r.pause();
        const close = (): void => {
          try {
            controller.close();
          } catch {
            /* already closed or errored */
          }
        };
        r.on("end", close);
        r.on("close", close);
        r.on("error", (e: unknown) => {
          try {
            controller.error(e);
          } catch {
            /* already closed */
          }
        });
      },
      pull() {
        r.resume();
      },
      cancel(reason) {
        r.destroy(reason instanceof Error ? reason : undefined);
      },
    });
  }

  static fromWeb(web: ReadableStream<any>, options: StreamOptions = {}): Readable {
    const reader = web.getReader();
    return new Readable({
      ...options,
      read() {
        reader.read().then(
          ({ value, done }) => {
            if (done) this.push(null);
            else
              this.push(
                typeof value === "string" || options.objectMode ? value : Buffer.from(value),
              );
          },
          (err) => this.destroy(err),
        );
      },
      destroy(err, cb) {
        reader.cancel(err).then(
          () => cb(err),
          () => cb(err),
        );
      },
    });
  }
}

// ---------------------------------------------------------------- Writable

function initWritable(self: StreamBase, options: StreamOptions): void {
  const objectMode = options.objectMode === true;
  self._ws = {
    queue: [],
    writing: false,
    length: 0,
    hwm: options.highWaterMark ?? (objectMode ? 16 : 16384),
    ending: false,
    finalCalled: false,
    finished: false,
    needDrain: false,
    objectMode,
    decodeStrings: options.decodeStrings !== false,
    defaultEncoding: options.defaultEncoding ?? "utf8",
    corked: 0,
    autoDestroy: options.autoDestroy !== false,
  };
  const w = self as unknown as Writable;
  if (options.write) w._write = options.write;
  if (options.final) w._final = options.final;
  if (options.destroy) (self as unknown as { _destroy: unknown })._destroy = options.destroy;
}

export class Writable extends StreamBase {
  static [Symbol.hasInstance](o: unknown): boolean {
    if (this !== Writable) return Function.prototype[Symbol.hasInstance].call(this, o);
    return (
      Function.prototype[Symbol.hasInstance].call(Writable, o) ||
      (typeof o === "object" && o !== null && (o as StreamBase)._ws !== undefined)
    );
  }

  constructor(options: StreamOptions = {}) {
    super();
    initWritable(this, options);
  }

  private get ws(): WritableState {
    return this._ws!;
  }

  get writable(): boolean {
    return !this.destroyed && !this.ws.ending;
  }
  get writableEnded(): boolean {
    return this.ws.ending;
  }
  get writableFinished(): boolean {
    return this.ws.finished;
  }
  get writableLength(): number {
    return this.ws.length;
  }
  get writableHighWaterMark(): number {
    return this.ws.hwm;
  }
  get writableObjectMode(): boolean {
    return this.ws.objectMode;
  }
  get writableNeedDrain(): boolean {
    return this.ws.needDrain;
  }
  get writableCorked(): boolean {
    return this.ws.corked > 0;
  }

  _write(_chunk: unknown, _enc: string, cb: Cb): void {
    cb(nodeError("ERR_METHOD_NOT_IMPLEMENTED", "The _write() method is not implemented"));
  }
  _final?(cb: Cb): void;

  write(chunk: unknown, encoding?: string | Cb, cb?: Cb): boolean {
    if (typeof encoding === "function") {
      cb = encoding;
      encoding = undefined;
    }
    const w = this.ws;
    if (chunk === null)
      throw nodeError("ERR_STREAM_NULL_VALUES", "May not write null values to stream", {
        name: "TypeError",
      });
    if (w.ending) {
      const err = nodeError("ERR_STREAM_WRITE_AFTER_END", "write after end");
      schedule(() => cb?.(err));
      this.destroy(err);
      return false;
    }
    if (this.destroyed) {
      const err = nodeError(
        "ERR_STREAM_DESTROYED",
        "Cannot call write after a stream was destroyed",
      );
      schedule(() => cb?.(err));
      return false;
    }
    let enc = (encoding as string | undefined) ?? w.defaultEncoding;
    let c = chunk;
    if (!w.objectMode) {
      if (typeof c === "string") {
        if (w.decodeStrings) {
          c = Buffer.from(c, enc);
          enc = "buffer";
        }
      } else if (c instanceof Uint8Array) {
        if (!(c instanceof Buffer))
          c = Buffer.from(c.buffer as ArrayBuffer, c.byteOffset, c.byteLength);
        enc = "buffer";
      } else {
        throw nodeError(
          "ERR_INVALID_ARG_TYPE",
          `The "chunk" argument must be of type string or an instance of Buffer or Uint8Array. Received ${typeof c}`,
          { name: "TypeError" },
        );
      }
    }
    const len = w.objectMode ? 1 : (c as { length: number }).length;
    w.length += len;
    const ok = w.length < w.hwm;
    if (!ok) w.needDrain = true;
    w.queue.push({ chunk: c, enc, cb, len });
    this.pump();
    return ok;
  }

  private pump(): void {
    const w = this.ws;
    if (w.writing || this.destroyed || w.corked > 0) return;
    const item = w.queue.shift();
    if (!item) {
      this.afterQueueEmpty();
      return;
    }
    w.writing = true;
    let sync = true;
    let called = false;
    const done: Cb = (err) => {
      if (called) return;
      called = true;
      const finish = (): void => {
        w.writing = false;
        w.length -= item.len;
        if (err) {
          item.cb?.(err);
          this.destroy(err);
          return;
        }
        item.cb?.(null);
        if (this.destroyed) return;
        if (w.needDrain && w.queue.length === 0 && w.length === 0 && !w.ending) {
          w.needDrain = false;
          this.emit("drain");
        }
        this.pump();
      };
      if (sync) schedule(finish);
      else finish();
    };
    try {
      this._write(item.chunk, item.enc, done);
    } catch (e) {
      done(e as Error);
    }
    sync = false;
  }

  private afterQueueEmpty(): void {
    const w = this.ws;
    if (!w.ending || w.finalCalled || w.queue.length > 0 || w.writing) return;
    w.finalCalled = true;
    const finish: Cb = (err) => {
      if (err) {
        this.destroy(err);
        return;
      }
      w.finished = true;
      schedule(() => {
        if (this.destroyed) return;
        this.emit("finish");
        if (w.autoDestroy && (!this._rs || this._rs.endEmitted)) schedule(() => this.destroy());
      });
    };
    if (this._final) this._final(finish);
    else finish();
  }

  protected override _onDestroy(): void {
    const w = this._ws;
    if (!w) return;
    const pending = w.queue.splice(0);
    const err = nodeError("ERR_STREAM_DESTROYED", "Cannot call write after a stream was destroyed");
    for (const item of pending) schedule(() => item.cb?.(err));
  }

  end(chunk?: unknown, encoding?: string | Cb, cb?: Cb): this {
    if (typeof chunk === "function") {
      cb = chunk as Cb;
      chunk = undefined;
    } else if (typeof encoding === "function") {
      cb = encoding;
      encoding = undefined;
    }
    const w = this.ws;
    if (chunk !== undefined && chunk !== null) this.write(chunk, encoding as string | undefined);
    if (cb) {
      const onDone = cb;
      if (w.finished) schedule(() => onDone());
      else {
        const onFinish = (): void => {
          this.removeListener("error", onError);
          onDone();
        };
        const onError = (e: Error): void => {
          this.removeListener("finish", onFinish);
          onDone(e);
        };
        this.once("finish", onFinish);
        this.once("error", onError);
      }
    }
    if (!w.ending) {
      w.ending = true;
      this.pump();
    }
    return this;
  }

  cork(): void {
    this.ws.corked++;
  }
  uncork(): void {
    const w = this.ws;
    if (w.corked > 0) w.corked--;
    if (w.corked === 0) this.pump();
  }
  setDefaultEncoding(enc: string): this {
    this.ws.defaultEncoding = enc;
    return this;
  }

  static toWeb(w: Writable): WritableStream<any> {
    return new WritableStream<any>({
      write(chunk) {
        return new Promise<void>((resolve, reject) =>
          w.write(chunk, (err) => (err ? reject(err) : resolve())),
        );
      },
      close() {
        return new Promise<void>((resolve, reject) =>
          w.end(undefined, undefined, (err) => (err ? reject(err) : resolve())),
        );
      },
      abort(reason) {
        w.destroy(reason instanceof Error ? reason : undefined);
      },
    });
  }
}

// ---------------------------------------------------------------- Duplex / Transform

// Node's stream.Duplex is a class that also carries Writable's members; the interface adds the
// type side without a second implementation.
// eslint-disable-next-line typescript/no-unsafe-declaration-merging
export interface Duplex extends Pick<
  Writable,
  | "write"
  | "end"
  | "cork"
  | "uncork"
  | "setDefaultEncoding"
  | "writable"
  | "writableEnded"
  | "writableFinished"
  | "writableLength"
  | "writableHighWaterMark"
  | "writableObjectMode"
  | "writableNeedDrain"
  | "writableCorked"
> {}
export class Duplex extends Readable {
  constructor(options: StreamOptions = {}) {
    super(options);
    initWritable(this, options);
  }
  _write(_chunk: unknown, _enc: string, cb: Cb): void {
    cb(nodeError("ERR_METHOD_NOT_IMPLEMENTED", "The _write() method is not implemented"));
  }
  _final?(cb: Cb): void;
}
for (const name of Object.getOwnPropertyNames(Writable.prototype)) {
  if (name === "constructor") continue;
  Object.defineProperty(
    Duplex.prototype,
    name,
    Object.getOwnPropertyDescriptor(Writable.prototype, name)!,
  );
}
// Duplex's own `writable` must reflect both halves being open for writing only.

export class Transform extends Duplex {
  constructor(options: StreamOptions = {}) {
    super(options);
    if (options.transform) this._transform = options.transform;
    if (options.flush) this._flush = options.flush;
  }

  _transform(
    _chunk: unknown,
    _enc: string,
    cb: (err?: Error | null, data?: unknown) => void,
  ): void {
    cb(nodeError("ERR_METHOD_NOT_IMPLEMENTED", "The _transform() method is not implemented"));
  }
  _flush?(cb: (err?: Error | null, data?: unknown) => void): void;

  override _write(chunk: unknown, enc: string, cb: Cb): void {
    this._transform(chunk, enc, (err, data) => {
      if (err) return cb(err);
      if (data !== undefined && data !== null) this.push(data);
      cb();
    });
  }
  override _final(cb: Cb): void {
    if (!this._flush) {
      this.push(null);
      cb();
      return;
    }
    this._flush((err, data) => {
      if (err) return cb(err);
      if (data !== undefined && data !== null) this.push(data);
      this.push(null);
      cb();
    });
  }
}

export class PassThrough extends Transform {
  override _transform(
    chunk: unknown,
    _enc: string,
    cb: (err?: Error | null, data?: unknown) => void,
  ): void {
    cb(null, chunk);
  }
}

// ---------------------------------------------------------------- finished / pipeline

export function finished(
  stream: StreamBase,
  optionsOrCb: { readable?: boolean; writable?: boolean } | ((err?: Error | null) => void),
  maybeCb?: (err?: Error | null) => void,
): () => void {
  const cb = typeof optionsOrCb === "function" ? optionsOrCb : maybeCb!;
  const opts = typeof optionsOrCb === "function" ? {} : optionsOrCb;
  let readDone = !stream._rs || opts.readable === false || stream._rs.endEmitted;
  let writeDone = !stream._ws || opts.writable === false || stream._ws.finished;
  let called = false;
  const cleanup = (): void => {
    stream.removeListener("end", onEnd);
    stream.removeListener("finish", onFinish);
    stream.removeListener("error", onError);
    stream.removeListener("close", onClose);
  };
  const fire = (err?: Error | null): void => {
    if (called) return;
    called = true;
    cleanup();
    cb(err);
  };
  const check = (): void => {
    if (readDone && writeDone) fire();
  };
  const onEnd = (): void => {
    readDone = true;
    check();
  };
  const onFinish = (): void => {
    writeDone = true;
    check();
  };
  const onError = (e: Error): void => fire(e);
  const onClose = (): void => fire(readDone && writeDone ? undefined : errPrematureClose());
  stream.on("end", onEnd);
  stream.on("finish", onFinish);
  stream.on("error", onError);
  stream.on("close", onClose);
  if (readDone && writeDone) schedule(() => fire());
  else if (stream.closed) schedule(() => fire(errPrematureClose()));
  return cleanup;
}

export function pipeline(...args: any[]): any {
  const cb: ((err?: Error | null) => void) | undefined =
    typeof args[args.length - 1] === "function" ? args.pop() : undefined;
  const list: any[] = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
  const streams: StreamBase[] = list.map((s: any, i: number) => {
    if (s instanceof StreamBase) return s;
    if (i === 0 && s && (s[Symbol.asyncIterator] || s[Symbol.iterator])) return Readable.from(s);
    throw nodeError(
      "ERR_INVALID_ARG_TYPE",
      "pipeline() supports streams (and an iterable source) only",
      {
        name: "TypeError",
      },
    );
  });
  if (streams.length < 2)
    throw nodeError("ERR_MISSING_ARGS", 'The "streams" argument must be specified');
  let settled = false;
  const completed = new Set<StreamBase>();
  const settle = (err?: Error | null): void => {
    if (settled) return;
    settled = true;
    // Like Node: streams that already finished cleanly are left alone (destroying them with an
    // error would emit an 'error' nobody listens for any more).
    if (err) for (const s of streams) if (!completed.has(s)) s.destroy(err);
    cb?.(err);
  };
  streams.forEach((s, i) => {
    const onDone = (err?: Error | null): void => {
      if (!err) completed.add(s);
      else settle(err);
    };
    if (i < streams.length - 1) {
      (s as Readable).pipe(streams[i + 1] as unknown as WritableLike);
      finished(s, { writable: false }, onDone);
    } else finished(s, (err) => (onDone(err), err ? undefined : settle()));
  });
  return streams[streams.length - 1];
}

export const promises = {
  pipeline: (...streams: any[]): Promise<void> =>
    new Promise((resolve, reject) =>
      pipeline(...streams, (err?: Error | null) => (err ? reject(err) : resolve())),
    ),
  finished: (
    stream: StreamBase,
    opts?: { readable?: boolean; writable?: boolean },
  ): Promise<void> =>
    new Promise((resolve, reject) =>
      finished(stream, opts ?? {}, (err) => (err ? reject(err) : resolve())),
    ),
};

export const streamModule = Object.assign(Stream, {
  Stream,
  Readable,
  Writable,
  Duplex,
  Transform,
  PassThrough,
  pipeline,
  finished,
  promises,
});
