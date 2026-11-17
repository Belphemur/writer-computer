import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  bytesToBase64,
  installGlobalFetch,
  pluginScopedFetch,
  setNetIpc,
  type HttpRequestWire,
  type NetIpc,
  type StreamEventWire,
} from "../web/host/api/network";

const enc = (s: string) => new TextEncoder().encode(s);
const tick = () => new Promise((r) => setTimeout(r, 0));

function fakeIpc(opts: { failStart?: string } = {}) {
  const ipc = {
    seen: [] as HttpRequestWire[],
    emit: null as null | ((ev: StreamEventWire) => void),
    cancelled: [] as number[],
    async request() {
      throw new Error("unused");
    },
    async streamStart(r: HttpRequestWire, onEvent: (ev: StreamEventWire) => void) {
      if (opts.failStart) throw new Error(opts.failStart);
      ipc.seen.push(r);
      ipc.emit = onEvent;
      return 7;
    },
    async streamCancel(id: number) {
      ipc.cancelled.push(id);
      return true;
    },
  };
  return ipc satisfies NetIpc;
}
const head = (status = 200, headers: [string, string][] = []): StreamEventWire => ({
  type: "head",
  status,
  headers,
  url: "https://api.test/v1",
});
const chunk = (s: string): StreamEventWire => ({
  type: "chunk",
  data_base64: bytesToBase64(enc(s)),
});

afterEach(() => {
  setNetIpc(null);
  vi.restoreAllMocks();
});

describe("plugin fetch", () => {
  it("non-stream: text/json/clone and request wire shape", async () => {
    const ipc = fakeIpc();
    setNetIpc(ipc);
    const p = pluginScopedFetch("https://api.test/v1", {
      method: "POST",
      headers: { Authorization: "Bearer k", "content-type": "application/json" },
      body: '{"a":1}',
    });
    await tick();
    ipc.emit!(head(200, [["content-type", "application/json"]]));
    ipc.emit!(chunk('{"ok":'));
    ipc.emit!(chunk("true}"));
    ipc.emit!({ type: "end" });
    const res = await p;
    const copy = res.clone();
    expect(res.status).toBe(200);
    expect(res.url).toBe("https://api.test/v1");
    expect(await res.json()).toEqual({ ok: true });
    expect(await copy.text()).toBe('{"ok":true}');
    const w = ipc.seen[0];
    expect(w.method).toBe("POST");
    expect(w.headers!.authorization).toBe("Bearer k");
    expect(w.follow_redirects).toBe(true);
    expect(
      new TextDecoder().decode(Uint8Array.from(atob(w.body_base64!), (c) => c.charCodeAt(0))),
    ).toBe('{"a":1}');
  });

  it("accepts URLSearchParams, FormData of strings and Uint8Array bodies", async () => {
    const ipc = fakeIpc();
    setNetIpc(ipc);
    void pluginScopedFetch("https://api.test/a", {
      method: "POST",
      body: new URLSearchParams({ a: "1" }),
    });
    void pluginScopedFetch("https://api.test/b", { method: "POST", body: new Uint8Array([1, 2]) });
    const fd = new FormData();
    fd.set("k", "v");
    void pluginScopedFetch("https://api.test/c", { method: "POST", body: fd });
    await tick();
    expect(ipc.seen).toHaveLength(3);
    expect(ipc.seen[0].headers!["content-type"]).toContain("x-www-form-urlencoded");
    expect(ipc.seen[1].body_base64).toBe(bytesToBase64(new Uint8Array([1, 2])));
    expect(ipc.seen[2].headers!["content-type"]).toContain("multipart/form-data");
  });

  it("streams chunks incrementally and in order", async () => {
    const ipc = fakeIpc();
    setNetIpc(ipc);
    const p = pluginScopedFetch("https://api.test/v1");
    await tick();
    ipc.emit!(head(200, [["content-type", "text/event-stream"]]));
    const res = await p;
    const reader = res.body!.getReader();
    ipc.emit!(chunk("data: 1\n\n"));
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("data: 1\n\n");
    ipc.emit!(chunk("data: 2\n\n"));
    ipc.emit!({ type: "end" });
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: 2\n\n");
    expect((await reader.read()).done).toBe(true);
  });

  it("abort before head rejects and cancels; abort after head errors the body", async () => {
    const ipc = fakeIpc();
    setNetIpc(ipc);
    const ac = new AbortController();
    const p = pluginScopedFetch("https://api.test/v1", { signal: ac.signal });
    await tick();
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    await tick();
    expect(ipc.cancelled).toEqual([7]);

    const ac2 = new AbortController();
    const p2 = pluginScopedFetch("https://api.test/v1", { signal: ac2.signal });
    await tick();
    ipc.emit!(head());
    const res = await p2;
    ac2.abort();
    await expect(res.text()).rejects.toMatchObject({ name: "AbortError" });
    expect(ipc.cancelled).toEqual([7, 7]);

    const done = new AbortController();
    done.abort();
    await expect(
      pluginScopedFetch("https://api.test/v1", { signal: done.signal }),
    ).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("cancelling the body cancels the stream", async () => {
    const ipc = fakeIpc();
    setNetIpc(ipc);
    const p = pluginScopedFetch("https://api.test/v1");
    await tick();
    ipc.emit!(head());
    const res = await p;
    await res.body!.cancel();
    await tick();
    expect(ipc.cancelled).toEqual([7]);
  });

  it("maps errors to TypeError('Failed to fetch: ...')", async () => {
    setNetIpc(fakeIpc({ failStart: "refused: nope" }));
    await expect(pluginScopedFetch("https://api.test/v1")).rejects.toThrow(
      new TypeError("Failed to fetch: refused: nope"),
    );
    const ipc = fakeIpc();
    setNetIpc(ipc);
    const p = pluginScopedFetch("https://api.test/v1");
    await tick();
    ipc.emit!({ type: "error", message: "dns" });
    await expect(p).rejects.toBeInstanceOf(TypeError);
    await expect(p).rejects.toThrow("Failed to fetch: dns");
  });

  it("redirect option maps to follow_redirects", async () => {
    const ipc = fakeIpc();
    setNetIpc(ipc);
    void pluginScopedFetch("https://api.test/v1", { redirect: "manual" });
    await tick();
    expect(ipc.seen[0].follow_redirects).toBe(false);
  });

  it("falls through for non-http(s), data:/blob:/ipc:/asset: and same-origin", async () => {
    const native = vi.fn(async () => new Response("native"));
    const g = globalThis as { fetch: unknown };
    const orig = g.fetch;
    g.fetch = native;
    const ipc = fakeIpc();
    setNetIpc(ipc);
    try {
      const uninstall = installGlobalFetch();
      for (const u of [
        "data:text/plain,hi",
        "blob:https://x/1",
        "ipc://localhost/cmd",
        "asset://localhost/a",
        "writer-plugin://localhost/id/main.js",
        "ftp://x/y",
        "http://ipc.localhost/cmd",
      ]) {
        expect(await (await pluginScopedFetch(u)).text()).toBe("native");
      }
      expect(native).toHaveBeenCalledTimes(7);
      expect(ipc.seen).toHaveLength(0);
      uninstall();
    } finally {
      g.fetch = orig;
    }
  });
});

describe("global patch", () => {
  it("installs, is idempotent, and restores", () => {
    const g = globalThis as { fetch: unknown };
    const orig = g.fetch;
    const un1 = installGlobalFetch();
    expect(g.fetch).toBe(pluginScopedFetch);
    const un2 = installGlobalFetch();
    expect(g.fetch).toBe(pluginScopedFetch);
    un2(); // no-op: not the owner
    expect(g.fetch).toBe(pluginScopedFetch);
    un1();
    expect(g.fetch).toBe(orig);
    un1();
    expect(g.fetch).toBe(orig);
  });

  it("does not clobber a wrapper installed on top", () => {
    const g = globalThis as { fetch: unknown };
    const orig = g.fetch;
    const un = installGlobalFetch();
    const wrapper = () => Promise.resolve(new Response());
    g.fetch = wrapper;
    un();
    expect(g.fetch).toBe(wrapper);
    g.fetch = orig;
  });
});
