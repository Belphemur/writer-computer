import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { makeRequire } from "../src/lib/obsidian-host/modules";
import { Buffer } from "../src/lib/obsidian-host/node/buffer";
import { cryptoModule } from "../src/lib/obsidian-host/node/crypto";
import { EventEmitter } from "../src/lib/obsidian-host/node/events";
import { createHttpModule } from "../src/lib/obsidian-host/node/http";
import { electronModule, setOpenExternal } from "../src/lib/obsidian-host/node/misc";
import { osModule } from "../src/lib/obsidian-host/node/os";
import { posix, win32 } from "../src/lib/obsidian-host/node/path";
import { createProcessShim, getSharedProcess } from "../src/lib/obsidian-host/node/process";
import { installNodeGlobals, preloadNodeRuntime } from "../src/lib/obsidian-host/node/runtime";
import { resetNodeRuntimeForTests } from "../src/lib/obsidian-host/node/state";
import { StringDecoder } from "../src/lib/obsidian-host/node/string-decoder";
import { FakeNodeIpc, flush } from "../src/lib/obsidian-host/node/testing";
import {
  format,
  inspect,
  inherits,
  promisify,
  types,
  utilModule,
} from "../src/lib/obsidian-host/node/util";

beforeEach(() => resetNodeRuntimeForTests());
afterEach(() => vi.restoreAllMocks());

describe("events", () => {
  it("emits in registration order, once fires once, off removes", () => {
    const e = new EventEmitter();
    const seen: string[] = [];
    const a = () => seen.push("a");
    e.on("x", a);
    e.once("x", () => seen.push("once"));
    e.prependListener("x", () => seen.push("first"));
    expect(e.emit("x")).toBe(true);
    expect(e.emit("x")).toBe(true);
    expect(seen).toEqual(["first", "a", "once", "first", "a"]);
    e.off("x", a);
    expect(e.listenerCount("x")).toBe(1);
    expect(e.emit("nothing")).toBe(false);
  });

  it("passes args and `this`, tolerates removal during emit", () => {
    const e = new EventEmitter();
    const seen: unknown[] = [];
    const second = () => seen.push("second");
    e.on("x", function (this: unknown, a: number, b: number) {
      seen.push([this === e, a, b]);
      e.off("x", second);
    });
    e.on("x", second);
    e.emit("x", 1, 2);
    expect(seen).toEqual([[true, 1, 2], "second"]); // the snapshot still runs it
    e.emit("x", 3, 4);
    expect(seen).toHaveLength(3);
  });

  it("throws an unhandled 'error' and delivers a handled one", () => {
    const e = new EventEmitter();
    expect(() => e.emit("error", new Error("boom"))).toThrow("boom");
    expect(() => e.emit("error", "str")).toThrow(/Unhandled error/);
    const got: unknown[] = [];
    e.on("error", (x) => got.push(x));
    e.emit("error", 7);
    expect(got).toEqual([7]);
  });

  it("supports listeners(), eventNames(), removeAllListeners and newListener", () => {
    const e = new EventEmitter();
    const added: unknown[] = [];
    e.on("newListener", (n) => added.push(n));
    const f = () => {};
    e.on("a", f);
    e.once("b", f);
    expect(added).toEqual(["a", "b"]);
    expect(e.listeners("a")).toEqual([f]);
    expect(e.eventNames()).toEqual(expect.arrayContaining(["a", "b"]));
    e.removeAllListeners("a");
    expect(e.listenerCount("a")).toBe(0);
    expect(e.listenerCount("b")).toBe(1);
    expect(e.getMaxListeners()).toBe(10);
  });

  it("captureRejections routes async listener failures to 'error'", async () => {
    const e = new EventEmitter({ captureRejections: true });
    const errs: unknown[] = [];
    e.on("error", (x) => errs.push(x));
    e.on("go", async () => {
      throw new Error("async boom");
    });
    e.emit("go");
    await flush();
    expect((errs[0] as Error).message).toBe("async boom");
  });

  it("EventEmitter.once resolves with args and rejects on error", async () => {
    const e = new EventEmitter();
    const p = EventEmitter.once(e, "ready");
    e.emit("ready", 1, 2);
    expect(await p).toEqual([1, 2]);
    const q = EventEmitter.once(e, "ready");
    e.emit("error", new Error("nope"));
    await expect(q).rejects.toThrow("nope");
    expect(e.listenerCount("ready")).toBe(0);
  });

  it("can be subclassed", () => {
    class Thing extends EventEmitter {}
    const t = new Thing();
    expect(t).toBeInstanceOf(EventEmitter);
    expect(EventEmitter.EventEmitter).toBe(EventEmitter);
  });
});

describe("buffer", () => {
  it("is a Uint8Array subclass and encodes/decodes utf8, hex, base64, base64url, latin1", () => {
    const b = Buffer.from("héllo €", "utf8");
    expect(b).toBeInstanceOf(Uint8Array);
    expect(Buffer.isBuffer(b)).toBe(true);
    expect(Buffer.isBuffer(new Uint8Array(1))).toBe(false);
    expect(b.toString()).toBe("héllo €");
    expect(b.toString("hex")).toBe("68c3a96c6c6f20e282ac");
    expect(Buffer.from("68c3a9", "hex").toString()).toBe("hé");
    expect(Buffer.from("aGk=", "base64").toString()).toBe("hi");
    expect(Buffer.from("aGk", "base64").toString()).toBe("hi"); // unpadded
    expect(Buffer.from("hi?>", "utf8").toString("base64")).toBe("aGk/Pg==");
    expect(Buffer.from("hi?>").toString("base64url")).toBe("aGk_Pg");
    expect(Buffer.from("aGk_Pg", "base64url").toString()).toBe("hi?>");
    expect(Buffer.from([0xe9, 0x41]).toString("latin1")).toBe("éA");
    expect(Buffer.from("é", "latin1")[0]).toBe(0xe9);
    expect(Buffer.from("ab", "utf16le")).toEqual(Buffer.from([0x61, 0, 0x62, 0]));
    expect(() => Buffer.from("x", "nope" as never)).toThrow(/Unknown encoding/);
  });

  it("byteLength, alloc, concat, slice sharing, subarray type, indexOf, equals", () => {
    expect(Buffer.byteLength("é€")).toBe(5);
    expect(Buffer.alloc(3, 7)).toEqual(Buffer.from([7, 7, 7]));
    expect(Buffer.alloc(5, "ab").toString()).toBe("ababa");
    const c = Buffer.concat([Buffer.from("ab"), Buffer.from("cd")]);
    expect(c.toString()).toBe("abcd");
    expect(Buffer.concat([Buffer.from("abcd")], 2).toString()).toBe("ab");
    const s = c.slice(1, 3);
    s[0] = 0x7a;
    expect(c.toString()).toBe("azcd"); // slice shares memory
    expect(c.subarray(0, 1)).toBeInstanceOf(Buffer);
    expect(c.indexOf("cd")).toBe(2);
    expect(c.indexOf(0x64)).toBe(3);
    expect(c.indexOf("zz")).toBe(-1);
    expect(c.includes("az")).toBe(true);
    expect(Buffer.from("a").equals(Buffer.from("a"))).toBe(true);
    expect(Buffer.compare(Buffer.from("a"), Buffer.from("b"))).toBe(-1);
    expect(c.toJSON()).toEqual({ type: "Buffer", data: [97, 122, 99, 100] });
    expect(Buffer.from(c.toJSON())).toEqual(c);
  });

  it("reads and writes fixed-width integers; range-checks", () => {
    const b = Buffer.alloc(8);
    b.writeUInt16BE(0x1234, 0);
    b.writeUInt32LE(0xdeadbeef, 2);
    expect(b.readUInt16BE(0)).toBe(0x1234);
    expect(b.readUInt16LE(0)).toBe(0x3412);
    expect(b.readUInt32LE(2)).toBe(0xdeadbeef);
    expect(b.readUInt32BE(2)).toBe(0xefbeadde);
    expect(b.readInt8(2)).toBe(-17);
    expect(b.readUint8(0)).toBe(0x12);
    expect(() => b.readUInt32LE(6)).toThrow(/out of range/);
  });

  it("write/copy/fill behave like Node", () => {
    const b = Buffer.alloc(6);
    expect(b.write("héy", 1)).toBe(4);
    expect(b.toString("utf8", 1, 5)).toBe("héy");
    const t = Buffer.alloc(3);
    expect(b.copy(t, 0, 1, 4)).toBe(3);
    expect(t.toString("hex")).toBe("68c3a9");
    expect(Buffer.alloc(4).fill("ab").toString()).toBe("abab");
  });
});

describe("util", () => {
  it("promisify turns callbacks into promises and honours util.promisify.custom", async () => {
    const ok = promisify((a: number, cb: (e: null, v: number) => void) => cb(null, a + 1));
    expect(await ok(1)).toBe(2);
    const bad = promisify((cb: (e: Error) => void) => cb(new Error("x")));
    await expect(bad()).rejects.toThrow("x");
    const fn = Object.assign(() => 0, { [promisify.custom]: () => Promise.resolve("custom") });
    expect(await promisify(fn)()).toBe("custom");
    expect(promisify.custom).toBe(Symbol.for("nodejs.util.promisify.custom"));
  });

  it("format and inspect", () => {
    expect(format("%s=%d %j %%", "a", 5, { x: 1 })).toBe('a=5 {"x":1} %');
    expect(format("a", "b", 1)).toBe("a b 1");
    expect(format(1, { a: 1 })).toBe("1 { a: 1 }");
    expect(inspect({ a: 1, b: "x", c: [1, 2], d: { e: { f: { g: 1 } } } })).toBe(
      "{ a: 1, b: 'x', c: [ 1, 2 ], d: { e: { f: [Object] } } }",
    );
    const circ: Record<string, unknown> = {};
    circ.self = circ;
    expect(inspect(circ)).toContain("[Circular");
    expect(inspect(new Map([[1, 2]]))).toBe("Map(1) { 1 => 2 }");
    expect(inspect(Buffer.from("ab"))).toBe("<Buffer 61 62>");
    expect(inspect(() => 1)).toBe("[Function (anonymous)]");
    expect(inspect(null)).toBe("null");
  });

  it("exposes types, TextEncoder/Decoder, inherits, deprecate", () => {
    expect(types.isPromise(Promise.resolve())).toBe(true);
    expect(types.isUint8Array(Buffer.alloc(1))).toBe(true);
    expect(types.isDate(new Date())).toBe(true);
    expect(types.isAsyncFunction(async () => 1)).toBe(true);
    expect(utilModule.TextEncoder).toBe(TextEncoder);
    expect(utilModule.TextDecoder).toBe(TextDecoder);
    function A() {}
    function B() {}
    inherits(B, A);
    expect(new (B as never as new () => object)()).toBeInstanceOf(A);
    const f = () => 5;
    expect(utilModule.deprecate(f)()).toBe(5);
  });
});

describe("string_decoder", () => {
  it("holds a split multi-byte character until it is complete", () => {
    const d = new StringDecoder("utf8");
    const euro = Buffer.from("€"); // e2 82 ac
    expect(d.write(euro.subarray(0, 1))).toBe("");
    expect(d.write(euro.subarray(1, 2))).toBe("");
    expect(d.write(euro.subarray(2))).toBe("€");
    const emoji = Buffer.from("a😀b");
    let out = "";
    for (const byte of emoji) out += d.write(Buffer.from([byte]));
    expect(out + d.end()).toBe("a😀b");
  });

  it("flushes an incomplete tail as U+FFFD on end", () => {
    const d = new StringDecoder("utf8");
    expect(d.write(Buffer.from([0xe2, 0x82]))).toBe("");
    expect(d.end()).toBe("\ufffd");
  });

  it("handles base64, hex, latin1 and rejects unknown encodings", () => {
    const d = new StringDecoder("base64");
    expect(d.write(Buffer.from("ab"))).toBe("");
    expect(d.write(Buffer.from("cde"))).toBe("YWJj");
    expect(d.end()).toBe("ZGU=");
    expect(new StringDecoder("hex").write(Buffer.from([255, 1]))).toBe("ff01");
    expect(new StringDecoder("latin1").write(Buffer.from([0xe9]))).toBe("é");
    expect(() => new StringDecoder("nope")).toThrow(/Unknown encoding/);
    expect(new StringDecoder().write("already a string")).toBe("already a string");
  });
});

describe("path", () => {
  it("posix join/resolve/relative/normalize/dirname/basename/extname", () => {
    expect(posix.join("/a", "b", "../c", "d.txt")).toBe("/a/c/d.txt");
    expect(posix.join("", "")).toBe(".");
    expect(posix.normalize("a//b/./c/..")).toBe("a/b");
    expect(posix.normalize("./")).toBe("./");
    expect(posix.normalize("/../a")).toBe("/a");
    expect(posix.resolve("/a/b", "../c")).toBe("/a/c");
    expect(posix.relative("/a/b/c", "/a/d")).toBe("../../d");
    expect(posix.relative("/a", "/a")).toBe("");
    expect(posix.dirname("/a/b/")).toBe("/a");
    expect(posix.dirname("/")).toBe("/");
    expect(posix.dirname("a")).toBe(".");
    expect(posix.basename("/a/b.txt", ".txt")).toBe("b");
    expect(posix.basename("/a/b/")).toBe("b");
    expect(posix.extname("x.tar.gz")).toBe(".gz");
    expect(posix.extname(".bashrc")).toBe("");
    expect(posix.extname("a.")).toBe(".");
    expect(posix.isAbsolute("/x")).toBe(true);
    expect(posix.isAbsolute("x")).toBe(false);
    expect([posix.sep, posix.delimiter]).toEqual(["/", ":"]);
    expect(posix.format(posix.parse("/home/u/file.md"))).toBe("/home/u/file.md");
    expect(posix.parse("/home/u/file.md")).toEqual({
      root: "/",
      dir: "/home/u",
      base: "file.md",
      ext: ".md",
      name: "file",
    });
    expect(() => posix.join(1 as never)).toThrow(/must be of type string/);
  });

  it("resolves relative paths against the runtime cwd (vault base)", async () => {
    await preloadNodeRuntime({ ipc: new FakeNodeIpc(), basePath: "/Users/test/vault" });
    expect(posix.resolve("notes", "a.md")).toBe("/Users/test/vault/notes/a.md");
    expect(posix.resolve()).toBe("/Users/test/vault");
  });

  it("win32 flavour", () => {
    expect(win32.sep).toBe("\\");
    expect(win32.delimiter).toBe(";");
    expect(win32.join("C:\\a", "b", "..", "c.txt")).toBe("C:\\a\\c.txt");
    expect(win32.normalize("C:/a//b/./c")).toBe("C:\\a\\b\\c");
    expect(win32.isAbsolute("C:\\x")).toBe(true);
    expect(win32.isAbsolute("C:x")).toBe(false);
    expect(win32.isAbsolute("\\\\srv\\share\\x")).toBe(true);
    expect(win32.basename("C:\\a\\b.txt", ".txt")).toBe("b");
    expect(win32.dirname("C:\\a\\b.txt")).toBe("C:\\a");
    expect(win32.dirname("C:\\")).toBe("C:\\");
    expect(win32.extname("C:\\a\\b.txt")).toBe(".txt");
    expect(win32.resolve("C:\\a", "..\\b")).toBe("C:\\b");
    expect(win32.relative("C:\\a\\b", "C:\\a\\c\\d")).toBe("..\\c\\d");
    expect(win32.parse("C:\\a\\b.txt")).toMatchObject({
      root: "C:\\",
      dir: "C:\\a",
      base: "b.txt",
    });
    expect(posix.win32).toBe(win32);
    expect(win32.posix).toBe(posix);
  });
});

describe("preload, os and process", () => {
  it("seeds os, process.env (login PATH), cwd and the sync-probe cache before plugins run", async () => {
    const ipc = new FakeNodeIpc();
    ipc.probes["/Users/test/vault"] = { exists: true, is_dir: true };
    ipc.probes["/Users/test/.claude/settings.json"] = { exists: true, is_file: true, size: 3 };
    ipc.probes["/Users/test/.local/bin/claude"] = { exists: true, is_file: true };
    await preloadNodeRuntime({ ipc, basePath: "/Users/test/vault/" });
    expect(osModule.homedir()).toBe("/Users/test");
    expect(osModule.userInfo()).toMatchObject({ username: "test", shell: "/bin/zsh" });
    expect(osModule.tmpdir()).toBe("/var/tmp");
    expect(osModule.platform()).toBe("darwin");
    expect(osModule.type()).toBe("Darwin");
    expect(osModule.EOL).toBe("\n");
    expect(osModule.cpus()).toEqual([]);
    const p = getSharedProcess();
    expect(p.platform).toBe("darwin");
    expect(p.arch).toBe("arm64");
    expect(p.env.PATH).toBe("/opt/bin:/usr/bin");
    expect(p.env.HOME).toBe("/Users/test");
    expect(p.cwd()).toBe("/Users/test/vault");
    expect(p.versions.node).toBeUndefined();
    expect(typeof p.execPath).toBe("string");
    expect(typeof p.pid).toBe("number");
    expect(ipc.probeCalls[0]).toEqual(
      expect.arrayContaining([
        "/Users/test/vault",
        "/Users/test/.claude",
        "/Users/test/.claude/settings.json",
        "/Users/test/.claude/local/claude",
        "/Users/test/.local/bin/claude",
      ]),
    );
    const fs = makeRequire("p", {})("fs") as { existsSync(p: string): boolean };
    expect(fs.existsSync("/Users/test/vault")).toBe(true);
    expect(fs.existsSync("/Users/test/.claude/settings.json")).toBe(true);
    expect(fs.existsSync("/Users/test/.claude/local/claude")).toBe(false); // probed, absent
    expect(fs.existsSync("/etc/passwd")).toBe(false); // never probed
  });

  it("never rejects when the backend fails; falls back to defaults", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ipc = new FakeNodeIpc();
    ipc.failWith = { osInfo: "x", resolveLoginPath: "y", which: "z", fsProbe: "w" };
    await expect(preloadNodeRuntime({ ipc, basePath: "/v" })).resolves.toBeUndefined();
    expect(osModule.homedir()).toBe("/");
    expect(warn).toHaveBeenCalledTimes(4);
  });

  it("process stubs: nextTick, hrtime, listener no-ops, stdout/stderr write-only", async () => {
    const p = createProcessShim();
    const seen: number[] = [];
    p.nextTick((n: number) => seen.push(n), 3);
    expect(seen).toEqual([]);
    await Promise.resolve();
    expect(seen).toEqual([3]);
    const t = p.hrtime();
    expect(t).toHaveLength(2);
    expect(typeof p.hrtime.bigint()).toBe("bigint");
    expect(p.on("exit", () => {})).toBe(p);
    expect(p.emit("exit")).toBe(false);
    expect(() => p.exit(1)).not.toThrow();
    const cb = vi.fn();
    expect(p.stdout.write("hi", cb)).toBe(true);
    await Promise.resolve();
    expect(cb).toHaveBeenCalled();
    expect(() => p.emitWarning("w")).not.toThrow();
    expect(() => p.kill(999999)).toThrow(/ESRCH/);
  });
});

describe("crypto", () => {
  const hex = (alg: string, data: string | Buffer) =>
    cryptoModule.createHash(alg).update(data).digest("hex");

  it("sha256 test vectors", () => {
    expect(hex("sha256", "")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(hex("sha256", "abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(hex("sha256", "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
    expect(hex("sha256", "a".repeat(1_000_000))).toBe(
      "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
    );
    expect(hex("SHA256", "héllo")).toBe(hex("sha256", Buffer.from("héllo")));
  });

  it("sha1 test vectors, update chunks, base64 and Buffer digests", () => {
    expect(hex("sha1", "")).toBe("da39a3ee5e6b4b0d3255bfef95601890afd80709");
    expect(hex("sha1", "abc")).toBe("a9993e364706816aba3e25717850c26c9cd0d89d");
    const h = cryptoModule.createHash("sha256").update("a").update(Buffer.from("bc"));
    const copy = h.copy();
    expect(h.digest("base64")).toBe("ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=");
    expect(Buffer.isBuffer(copy.digest())).toBe(true);
    expect(() => h.digest()).toThrow(/already called/);
  });

  it("rejects unsupported digests; hmac matches RFC vectors", () => {
    expect(() => cryptoModule.createHash("sha512")).toThrow(/not supported/);
    expect(
      cryptoModule
        .createHmac("sha256", "key")
        .update("The quick brown fox jumps over the lazy dog")
        .digest("hex"),
    ).toBe("f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8");
    expect(
      cryptoModule
        .createHmac("sha1", "key")
        .update("The quick brown fox jumps over the lazy dog")
        .digest("hex"),
    ).toBe("de7c9b85b8b78aa6bc8a7a36f70a90701c9db4d9");
    // keys longer than the block size are hashed first
    expect(
      cryptoModule.createHmac("sha256", "k".repeat(100)).update("m").digest("hex"),
    ).toHaveLength(64);
  });

  it("randomBytes, randomUUID, randomInt, timingSafeEqual", async () => {
    const b = cryptoModule.randomBytes(70000) as Buffer;
    expect(b).toBeInstanceOf(Buffer);
    expect(b.length).toBe(70000);
    expect((cryptoModule.randomBytes(32) as Buffer).toString("hex")).toHaveLength(64);
    expect(cryptoModule.randomUUID()).toMatch(/^[0-9a-f-]{36}$/);
    for (let i = 0; i < 50; i++) expect([0, 1, 2]).toContain(cryptoModule.randomInt(3));
    const viaCb = await new Promise<Buffer>((res) =>
      cryptoModule.randomBytes(4, (_e, buf) => res(buf)),
    );
    expect(viaCb.length).toBe(4);
    expect(cryptoModule.timingSafeEqual(Buffer.from("a"), Buffer.from("a"))).toBe(true);
    expect(cryptoModule.timingSafeEqual(Buffer.from("a"), Buffer.from("b"))).toBe(false);
  });
});

describe("http / https / electron", () => {
  it("createServer().listen() fails asynchronously with EPERM and never throws or hangs", async () => {
    const http = createHttpModule("http:");
    const server = http.createServer(() => {});
    const errors: Array<Error & { code?: string }> = [];
    server.on("error", (e) => errors.push(e as never));
    const listenCb = vi.fn();
    const ret = server.listen(0, "127.0.0.1", listenCb);
    expect(ret).toBe(server);
    expect(errors).toEqual([]); // not synchronous
    await flush();
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe("EPERM");
    expect(errors[0].message).toMatch(/not available in Writer/);
    expect(listenCb).not.toHaveBeenCalled();
    expect(server.address()).toBeNull();
    expect(server.unref()).toBe(server);
    const closed = vi.fn();
    server.close(closed);
    await flush();
    expect(closed).toHaveBeenCalled();
  });

  it("warns instead of crashing when nobody listens for the listen error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    createHttpModule("https:").createServer().listen(0);
    await flush();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("EPERM"));
  });

  it("request()/get() stream over the global fetch", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("hello", { status: 201, headers: { "x-a": "b" } });
    });
    try {
      const http = createHttpModule("http:");
      const res = await new Promise<InstanceType<typeof http.IncomingMessage>>((resolve) =>
        http.get("http://example.test/p?q=1", { headers: { "X-K": "v" } }, resolve),
      );
      expect(res.statusCode).toBe(201);
      expect(res.headers["x-a"]).toBe("b");
      let body = "";
      for await (const chunk of res) body += (chunk as Buffer).toString();
      expect(body).toBe("hello");
      expect(calls[0].url).toBe("http://example.test/p?q=1");
      expect(new Headers(calls[0].init.headers).get("x-k")).toBe("v");

      const req = http.request({ method: "POST", hostname: "example.test", path: "/post" });
      const done = new Promise((r) => req.on("response", r));
      req.write("ab");
      req.end("cd");
      await done;
      expect(calls[1].url).toBe("http://example.test/post");
      expect(Buffer.from(calls[1].init.body as Uint8Array).toString()).toBe("abcd");
      expect(() => http.request("https://example.test/")).toThrow(/Protocol/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("request errors surface on the request, not as a throw", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("offline");
    });
    try {
      const req = createHttpModule("http:").request("http://example.test/");
      const err = new Promise<Error & { code?: string }>((r) => req.on("error", r as never));
      req.end();
      expect((await err).code).toBe("ECONNRESET");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("electron.shell.openExternal only opens http(s)/mailto and uses the opener", async () => {
    const open = vi.fn(async () => {});
    setOpenExternal(open);
    await electronModule.shell.openExternal("https://example.com/x");
    expect(open).toHaveBeenCalledWith("https://example.com/x");
    await expect(electronModule.shell.openExternal("file:///etc/passwd")).rejects.toThrow(
      /not allowed/,
    );
    await expect(electronModule.shell.openExternal("not a url")).rejects.toThrow(/Invalid URL/);
    setOpenExternal(null);
  });
});

describe("require", () => {
  const req = makeRequire("p", { obsidian: true });

  it("resolves every Node id, with and without the node: prefix", () => {
    for (const id of [
      "events",
      "buffer",
      "util",
      "string_decoder",
      "path",
      "path/posix",
      "path/win32",
      "os",
      "process",
      "stream",
      "stream/promises",
      "readline",
      "child_process",
      "fs",
      "fs/promises",
      "crypto",
      "http",
      "https",
      "net",
      "zlib",
      "url",
      "electron",
      "module",
      "util/types",
    ]) {
      expect(req(id), id).toBeTruthy();
      expect(req(`node:${id}`), `node:${id}`).toBe(req(id));
    }
    expect(req("events")).toBe(EventEmitter);
    expect((req("buffer") as { Buffer: unknown }).Buffer).toBe(Buffer);
    expect(req("process")).toBe(getSharedProcess());
    expect(req("obsidian")).toEqual({ obsidian: true });
  });

  it("node:module.createRequire returns the same require", () => {
    const mod = req("node:module") as {
      createRequire(u: string): unknown;
      builtinModules: string[];
    };
    expect(mod.createRequire("file:///x.js")).toBe(req);
    expect(mod.builtinModules).toContain("fs");
  });

  it("throws MODULE_NOT_FOUND for unknown ids", () => {
    let err: (Error & { code?: string }) | undefined;
    try {
      req("left-pad");
    } catch (e) {
      err = e as never;
    }
    expect(err?.message).toBe("Cannot find module 'left-pad'");
    expect(err?.code).toBe("MODULE_NOT_FOUND");
    expect(() => req("node:worker_threads")).toThrow("Cannot find module 'node:worker_threads'");
  });
});

describe("global install", () => {
  it("installs process/Buffer/require and restores on the last uninstall; idempotent", () => {
    const target: Record<string, unknown> = { process: undefined, keep: 1 };
    delete target.process;
    const req = (() => 1) as never;
    const u1 = installNodeGlobals(req, target);
    expect(target.process).toBe(getSharedProcess());
    expect(target.Buffer).toBe(Buffer);
    expect(target.require).toBe(req);
    const u2 = installNodeGlobals(() => 2, target);
    expect(target.require).toBe(req); // first installer wins
    u1();
    u1(); // idempotent
    expect(target.require).toBe(req); // u2 still holds it
    u2();
    expect("process" in target).toBe(false);
    expect("Buffer" in target).toBe(false);
    expect("require" in target).toBe(false);
    expect(target.keep).toBe(1);
  });

  it("restores a pre-existing global and leaves a replaced one alone", () => {
    const orig = () => "orig";
    const target: Record<string, unknown> = { require: orig };
    const un = installNodeGlobals(() => "ours", target);
    expect((target.require as () => string)()).toBe("ours");
    un();
    expect(target.require).toBe(orig);
    const un2 = installNodeGlobals(() => "ours", target);
    const other = () => "other";
    target.require = other;
    un2();
    expect(target.require).toBe(other);
  });

  it("never replaces a real Node process", () => {
    const real = { versions: { node: "22.0.0" } };
    const target: Record<string, unknown> = { process: real };
    const un = installNodeGlobals(() => 0, target);
    expect(target.process).toBe(real);
    expect(target.Buffer).toBeUndefined();
    expect(typeof target.require).toBe("function");
    un();
    expect(target.process).toBe(real);
    expect("require" in target).toBe(false);
  });
});
