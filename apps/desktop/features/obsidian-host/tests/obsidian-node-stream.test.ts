import { describe, expect, it } from "vite-plus/test";
import { Buffer } from "../web/host/node/buffer";
import { createInterface } from "../web/host/node/readline";
import {
  Duplex,
  PassThrough,
  Readable,
  Transform,
  Writable,
  finished,
  pipeline,
  promises,
  streamModule,
} from "../web/host/node/stream";
import { flush } from "../web/host/node/testing";

const collect = async (r: AsyncIterable<unknown>): Promise<Buffer[]> => {
  const out: Buffer[] = [];
  for await (const c of r) out.push(c as Buffer);
  return out;
};

describe("Readable", () => {
  it("delivers data in push order, then end, then close", async () => {
    const r = new Readable();
    const events: string[] = [];
    r.on("data", (c: Buffer) => events.push(`data:${c.toString()}`));
    r.on("end", () => events.push("end"));
    r.on("close", () => events.push("close"));
    r.push("a");
    r.push(Buffer.from("b"));
    r.push(new Uint8Array([99]));
    r.push(null);
    await flush();
    expect(events).toEqual(["data:a", "data:b", "data:c", "end", "close"]);
    expect(r.readableEnded).toBe(true);
    expect(r.destroyed).toBe(true);
  });

  it("data events are Buffers; setEncoding yields strings with multi-byte safety", async () => {
    const r = new Readable();
    r.setEncoding("utf8");
    const seen: unknown[] = [];
    r.on("data", (c) => seen.push(c));
    const euro = Buffer.from("€");
    r.push(euro.subarray(0, 2));
    r.push(euro.subarray(2));
    r.push(null);
    await flush();
    expect(seen).toEqual(["€"]);
  });

  it("buffers while paused and flushes in order on resume", async () => {
    const r = new Readable();
    const seen: string[] = [];
    r.on("data", (c: Buffer) => seen.push(c.toString()));
    r.pause();
    r.push("1");
    r.push("2");
    await flush();
    expect(seen).toEqual([]);
    expect(r.isPaused()).toBe(true);
    expect(r.readableLength).toBe(2);
    r.resume();
    await flush();
    expect(seen).toEqual(["1", "2"]);
  });

  it("does not flow or end until consumed", async () => {
    const r = new Readable();
    let ended = false;
    r.on("end", () => (ended = true));
    r.push("x");
    r.push(null);
    await flush();
    expect(ended).toBe(false);
    r.resume();
    await flush();
    expect(ended).toBe(true);
  });

  it("async iteration, early break destroys, errors reject", async () => {
    const r = new Readable();
    r.push("a");
    r.push("b");
    r.push(null);
    expect((await collect(r)).map((b) => b.toString())).toEqual(["a", "b"]);

    const r2 = new Readable();
    r2.push("a");
    for await (const c of r2) {
      expect((c as Buffer).toString()).toBe("a");
      break;
    }
    await flush();
    expect(r2.destroyed).toBe(true);

    const r3 = new Readable();
    r3.push("a");
    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const c of r3) {
          seen.push((c as Buffer).toString());
          r3.destroy(new Error("bad"));
        }
      })(),
    ).rejects.toThrow("bad");
    expect(seen).toEqual(["a"]);
  });

  it("destroy(err) emits error then close; push after EOF errors", async () => {
    const r = new Readable();
    const events: string[] = [];
    r.on("error", (e) => events.push(`error:${e.message}`));
    r.on("close", () => events.push("close"));
    r.destroy(new Error("x"));
    await flush();
    expect(events).toEqual(["error:x", "close"]);

    const r2 = new Readable();
    const errs: string[] = [];
    r2.on("error", (e: Error & { code?: string }) => errs.push(e.code ?? ""));
    r2.push(null);
    r2.push("late");
    await flush();
    expect(errs).toEqual(["ERR_STREAM_PUSH_AFTER_EOF"]);
  });

  it("calls _read when flowing and drained", async () => {
    let n = 0;
    const r = new Readable({
      read() {
        n++;
        this.push(n <= 3 ? `c${n}` : null);
      },
    });
    expect((await collect(r)).map((b) => b.toString())).toEqual(["c1", "c2", "c3"]);
  });

  it("read() supports the readable-event mode", async () => {
    const r = new Readable();
    const chunks: string[] = [];
    r.on("readable", () => {
      let c: Buffer | null;
      while ((c = r.read() as Buffer | null) !== null) chunks.push(c.toString());
    });
    const ended = new Promise((res) => r.on("end", res));
    r.push("ab");
    r.push("cd");
    await flush();
    r.push(null);
    await ended;
    expect(chunks.join("")).toBe("abcd");
  });

  it("Readable.from iterates arrays and async generators in object mode", async () => {
    const out: unknown[] = [];
    for await (const x of Readable.from(["a", 1, { k: 2 }])) out.push(x);
    expect(out).toEqual(["a", 1, { k: 2 }]);
    async function* gen() {
      yield "x";
      await flush();
      yield "y";
    }
    const g: unknown[] = [];
    for await (const x of Readable.from(gen())) g.push(x);
    expect(g).toEqual(["x", "y"]);
  });
});

describe("Writable", () => {
  it("serializes async _write calls in order and reports callbacks in order", async () => {
    const log: string[] = [];
    const w = new Writable({
      write(chunk, _enc, cb) {
        const s = (chunk as Buffer).toString();
        setTimeout(
          () => {
            log.push(`wrote:${s}`);
            cb();
          },
          s === "slow" ? 15 : 0,
        );
      },
    });
    const cbs: string[] = [];
    expect(w.write("slow", () => cbs.push("slow"))).toBe(true);
    expect(w.write("fast", () => cbs.push("fast"))).toBe(true);
    const finish = new Promise((r) => w.on("finish", r));
    w.end("last", () => cbs.push("end"));
    expect(w.writableEnded).toBe(true);
    expect(w.writableFinished).toBe(false);
    await finish;
    expect(log).toEqual(["wrote:slow", "wrote:fast", "wrote:last"]);
    expect(cbs).toEqual(["slow", "fast", "end"]);
    expect(w.writableFinished).toBe(true);
    await flush();
    expect(w.destroyed).toBe(true);
  });

  it("strings are decoded to Buffers; objectMode keeps values; bad chunk types throw", async () => {
    const got: unknown[] = [];
    const objects: unknown[] = [];
    const w = new Writable({
      write(c, enc, cb) {
        got.push([Buffer.isBuffer(c), enc]);
        cb();
      },
    });
    w.write("s");
    w.write(new Uint8Array([1]));
    const o = new Writable({
      objectMode: true,
      write(c, _e, cb) {
        objects.push(c);
        cb();
      },
    });
    o.write({ a: 1 });
    await flush();
    expect(got).toEqual([
      [true, "buffer"],
      [true, "buffer"],
    ]);
    expect(objects).toEqual([{ a: 1 }]);
    expect(() => w.write(5 as never)).toThrow(/must be of type string/);
    expect(() => w.write(null as never)).toThrow(/null/);
  });

  it("write after end errors via callback and 'error'; writableEnded is immediate", async () => {
    const w = new Writable({ write: (_c, _e, cb) => cb() });
    const errs: string[] = [];
    w.on("error", (e: Error & { code?: string }) => errs.push(e.code ?? ""));
    w.end();
    const cbErr = await new Promise<Error | null | undefined>((res) => w.write("x", res));
    expect((cbErr as Error & { code?: string }).code).toBe("ERR_STREAM_WRITE_AFTER_END");
    await flush();
    expect(errs).toEqual(["ERR_STREAM_WRITE_AFTER_END"]);
  });

  it("returns false past the high-water mark and emits drain once flushed", async () => {
    const w = new Writable({
      highWaterMark: 4,
      write: (_c, _e, cb) => setTimeout(cb, 1),
    });
    const events: string[] = [];
    w.on("drain", () => events.push("drain"));
    expect(w.write("ab")).toBe(true);
    expect(w.write("cde")).toBe(false);
    expect(w.writableNeedDrain).toBe(true);
    expect(w.writableLength).toBe(5);
    await flush(20);
    expect(events).toEqual(["drain"]);
    expect(w.writableLength).toBe(0);
  });

  it("a failing _write destroys the stream with that error", async () => {
    const w = new Writable({ write: (_c, _e, cb) => cb(new Error("disk")) });
    const errs: string[] = [];
    w.on("error", (e) => errs.push(e.message));
    const cbErr = await new Promise<Error | null | undefined>((res) => w.write("x", res));
    expect(cbErr?.message).toBe("disk");
    await flush();
    expect(errs).toEqual(["disk"]);
    expect(w.destroyed).toBe(true);
  });

  it("destroy fails pending write callbacks and write-after-destroy errors without an event", async () => {
    const w = new Writable({ write: () => {} /* never completes */ });
    const first = new Promise<Error | null | undefined>((res) => w.write("a", res));
    const second = new Promise<Error | null | undefined>((res) => w.write("b", res));
    w.destroy();
    void first;
    expect(((await second) as Error & { code?: string }).code).toBe("ERR_STREAM_DESTROYED");
    const after = await new Promise<Error | null | undefined>((res) => w.write("c", res));
    expect((after as Error & { code?: string }).code).toBe("ERR_STREAM_DESTROYED");
  });

  it("final() runs after the queue drains; cork/uncork batch", async () => {
    const order: string[] = [];
    const w = new Writable({
      write(c, _e, cb) {
        order.push(`w:${(c as Buffer).toString()}`);
        cb();
      },
      final(cb) {
        order.push("final");
        cb();
      },
    });
    w.cork();
    w.write("a");
    w.write("b");
    await flush();
    expect(order).toEqual([]);
    w.uncork();
    w.end();
    await new Promise((r) => w.on("finish", r));
    expect(order).toEqual(["w:a", "w:b", "final"]);
  });
});

describe("Duplex / Transform / PassThrough / pipe", () => {
  it("Transform maps chunks and flushes", async () => {
    const t = new Transform({
      transform(chunk, _e, cb) {
        cb(null, (chunk as Buffer).toString().toUpperCase());
      },
      flush(cb) {
        cb(null, "!");
      },
    });
    t.write("ab");
    t.end("cd");
    expect((await collect(t)).map((b) => b.toString()).join("")).toBe("ABCD!");
  });

  it("Duplex is instanceof Readable and Writable; Writable.hasInstance is duck-typed", () => {
    const d = new Duplex({ read() {}, write: (_c, _e, cb) => cb() });
    expect(d).toBeInstanceOf(Readable);
    expect(d).toBeInstanceOf(Writable);
    expect(new Readable()).not.toBeInstanceOf(Writable);
    expect(new PassThrough()).toBeInstanceOf(Writable);
    class MyW extends Writable {}
    expect(new Writable()).not.toBeInstanceOf(MyW);
  });

  it("pipe forwards data, ends the destination and respects backpressure", async () => {
    const got: string[] = [];
    const slow = new Writable({
      highWaterMark: 2,
      write(c, _e, cb) {
        got.push((c as Buffer).toString());
        setTimeout(cb, 2);
      },
    });
    const src = new Readable();
    src.pipe(slow);
    for (const s of ["aa", "bb", "cc", "dd"]) src.push(s);
    src.push(null);
    await new Promise((r) => slow.on("finish", r));
    expect(got).toEqual(["aa", "bb", "cc", "dd"]);
  });

  it("pipe(end:false) leaves the destination open; unpipe stops forwarding", async () => {
    const dest = new PassThrough();
    const src = new Readable();
    src.pipe(dest, { end: false });
    src.push("a");
    src.push(null);
    await flush();
    expect(dest.writableEnded).toBe(false);
    const src2 = new Readable();
    const dest2 = new PassThrough();
    src2.pipe(dest2);
    src2.unpipe(dest2);
    src2.push("x");
    await flush();
    expect(dest2.readableLength).toBe(0);
  });
});

describe("pipeline / finished / promises", () => {
  it("pipeline connects streams and calls back once", async () => {
    const out: string[] = [];
    const sink = new Writable({
      write(c, _e, cb) {
        out.push((c as Buffer).toString());
        cb();
      },
    });
    const up = new Transform({
      transform: (c, _e, cb) => cb(null, (c as Buffer).toString().toUpperCase()),
    });
    const src = Readable.from(["a", "b"]);
    await promises.pipeline(src, up, sink);
    expect(out.join("")).toBe("AB");
  });

  it("pipeline rejects and destroys everything when a stage errors", async () => {
    const boom = new Transform({ transform: (_c, _e, cb) => cb(new Error("stage")) });
    const sink = new PassThrough();
    const src = Readable.from(["a"]);
    await expect(promises.pipeline(src, boom, sink)).rejects.toThrow("stage");
    await flush();
    expect(src.destroyed && boom.destroyed && sink.destroyed).toBe(true);
  });

  it("callback-style pipeline returns the last stream", async () => {
    const last = new PassThrough();
    const done = new Promise<Error | null | undefined>((res) => {
      expect(pipeline(Readable.from(["x"]), last, (err?: Error | null) => res(err))).toBe(last);
    });
    last.resume();
    expect(await done).toBeUndefined();
  });

  it("finished fires for end, for premature close and for errors", async () => {
    const r = new Readable();
    const ok = new Promise<Error | null | undefined>((res) => finished(r, res));
    r.resume();
    r.push(null);
    expect(await ok).toBeUndefined();

    const r2 = new Readable();
    const premature = new Promise<Error | null | undefined>((res) => finished(r2, res));
    r2.destroy();
    expect(((await premature) as Error & { code?: string }).code).toBe(
      "ERR_STREAM_PREMATURE_CLOSE",
    );

    const w = new Writable({ write: (_c, _e, cb) => cb() });
    const wd = promises.finished(w);
    w.end();
    await expect(wd).resolves.toBeUndefined();
    await expect(promises.finished(w)).resolves.toBeUndefined(); // already finished

    const r3 = new Readable();
    const bad = promises.finished(r3);
    r3.destroy(new Error("e"));
    await expect(bad).rejects.toThrow("e");
  });

  it("the module object exposes the classes and promises", () => {
    expect(streamModule.Readable).toBe(Readable);
    expect(streamModule.promises.pipeline).toBe(promises.pipeline);
    expect(new Readable()).toBeInstanceOf(streamModule.Stream);
  });
});

describe("web stream interop", () => {
  it("Readable.toWeb yields Uint8Array chunks in order and closes", async () => {
    const r = new Readable();
    const web = Readable.toWeb(r);
    for (const s of ["he", "llo"]) r.push(s);
    r.push(null);
    const reader = web.getReader();
    let text = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      expect(value).toBeInstanceOf(Uint8Array);
      text += new TextDecoder().decode(value);
    }
    expect(text).toBe("hello");
  });

  it("Readable.toWeb pauses the source when the consumer is slow and cancel destroys it", async () => {
    const r = new Readable();
    const web = Readable.toWeb(r);
    for (let i = 0; i < 5; i++) r.push(`c${i}`);
    await flush();
    expect(r.isPaused()).toBe(true);
    const reader = web.getReader();
    expect((await reader.read()).done).toBe(false);
    await reader.cancel();
    await flush();
    expect(r.destroyed).toBe(true);
  });

  it("Readable.toWeb surfaces stream errors", async () => {
    const r = new Readable();
    const reader = Readable.toWeb(r).getReader();
    r.destroy(new Error("src failed"));
    await expect(reader.read()).rejects.toThrow("src failed");
  });

  it("Writable.toWeb writes in order and close() ends the stream", async () => {
    const got: string[] = [];
    const w = new Writable({
      write(c, _e, cb) {
        setTimeout(
          () => {
            got.push((c as Buffer).toString());
            cb();
          },
          got.length === 0 ? 10 : 0,
        );
      },
    });
    const writer = Writable.toWeb(w).getWriter();
    const enc = new TextEncoder();
    await writer.write(enc.encode("one"));
    await writer.write(enc.encode("two"));
    await writer.close();
    expect(got).toEqual(["one", "two"]);
    expect(w.writableFinished).toBe(true);
  });

  it("Writable.toWeb rejects writes when the node stream fails", async () => {
    const w = new Writable({ write: (_c, _e, cb) => cb(new Error("pipe broke")) });
    w.on("error", () => {});
    const writer = Writable.toWeb(w).getWriter();
    await expect(writer.write(new TextEncoder().encode("x"))).rejects.toThrow("pipe broke");
  });

  it("Readable.fromWeb reads a WHATWG stream", async () => {
    const web = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("ab"));
        c.enqueue(new TextEncoder().encode("cd"));
        c.close();
      },
    });
    const r = Readable.fromWeb(web);
    expect((await collect(r)).map((b) => b.toString()).join("")).toBe("abcd");
  });
});

describe("readline", () => {
  const lines = async (chunks: Array<string | Buffer>, opts: object = {}): Promise<string[]> => {
    const input = new Readable();
    const rl = createInterface({ input, ...opts } as never);
    const got: string[] = [];
    rl.on("line", (l) => got.push(l));
    const closed = new Promise((r) => rl.on("close", r));
    for (const c of chunks) input.push(c);
    input.push(null);
    await closed;
    return got;
  };

  it("splits on \\n and keeps partial lines across chunks", async () => {
    expect(await lines(["he", "llo\nwor", "ld\n", "!"])).toEqual(["hello", "world", "!"]);
  });

  it("handles CRLF, including CR and LF in different chunks, and lone CR", async () => {
    expect(await lines(["a\r\nb\r", "\nc\rd\n"], { crlfDelay: Infinity })).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
    expect(await lines(["a\r\r\nb"])).toEqual(["a", "", "b"]);
  });

  it("emits empty lines and drops a trailing newline's empty remainder", async () => {
    expect(await lines(["\n\nx\n"])).toEqual(["", "", "x"]);
    expect(await lines([])).toEqual([]);
  });

  it("decodes multi-byte characters split across chunks", async () => {
    const bytes = Buffer.from("é€😀\n");
    const chunks = [...bytes].map((b) => Buffer.from([b]));
    expect(await lines(chunks)).toEqual(["é€😀"]);
  });

  it("supports for await with a late producer and stops at close", async () => {
    const input = new Readable();
    const rl = createInterface({ input });
    const got: string[] = [];
    const loop = (async () => {
      for await (const l of rl) got.push(l);
    })();
    input.push('{"a":1}\n{"b"');
    await flush();
    input.push(":2}\n");
    await flush();
    expect(got).toEqual(['{"a":1}', '{"b":2}']);
    input.push("tail");
    input.push(null);
    await loop;
    expect(got).toEqual(['{"a":1}', '{"b":2}', "tail"]);
    expect(rl.closed).toBe(true);
  });

  it("close() stops line delivery, emits close once and ends iteration", async () => {
    const input = new Readable();
    const rl = createInterface(input);
    const events: string[] = [];
    rl.on("line", (l) => events.push(l));
    rl.on("close", () => events.push("close"));
    input.push("a\nb\n");
    await flush();
    rl.close();
    rl.close();
    input.push("c\n");
    await flush();
    expect(events).toEqual(["a", "b", "close"]);
    const it = rl[Symbol.asyncIterator]();
    expect(await it.next()).toEqual({ value: undefined, done: true });
  });

  it("break out of for await closes the interface", async () => {
    const input = new Readable();
    const rl = createInterface({ input });
    input.push("1\n2\n3\n");
    for await (const l of rl) {
      expect(l).toBe("1");
      break;
    }
    expect(rl.closed).toBe(true);
  });

  it("accepts string chunks from an encoded stream and question()", async () => {
    const input = new Readable();
    input.setEncoding("utf8");
    const out: string[] = [];
    const rl = createInterface({ input, output: { write: (s: string) => out.push(s) } });
    const answer = new Promise<string>((res) => rl.question("name? ", res));
    input.push("bob\n");
    expect(await answer).toBe("bob");
    expect(out).toEqual(["name? "]);
  });
});
