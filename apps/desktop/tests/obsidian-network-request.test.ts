import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  base64ToBytes,
  bytesToBase64,
  setNetIpc,
  type HttpRequestWire,
  type NetIpc,
} from "../src/lib/obsidian-host/api/network";
import { request, requestUrl } from "../src/lib/obsidian-host/api/functions";

function fakeIpc(
  res: { status: number; headers?: [string, string][]; body?: Uint8Array } | Error,
): NetIpc & { seen: HttpRequestWire[] } {
  const seen: HttpRequestWire[] = [];
  return {
    seen,
    async request(r) {
      seen.push(r);
      if (res instanceof Error) throw res;
      return {
        status: res.status,
        headers: res.headers ?? [],
        body_base64: bytesToBase64(res.body ?? new Uint8Array()),
        url: r.url,
      };
    },
    async streamStart() {
      throw new Error("unused");
    },
    async streamCancel() {
      return false;
    },
  };
}
const enc = (s: string) => new TextEncoder().encode(s);

afterEach(() => setNetIpc(null));

describe("requestUrl", () => {
  it("returns status, lowercased headers, text and json", async () => {
    const ipc = fakeIpc({
      status: 200,
      headers: [
        ["Content-Type", "application/json"],
        ["Set-Thing", "a"],
        ["set-thing", "b"],
      ],
      body: enc('{"a":1}'),
    });
    setNetIpc(ipc);
    const r = await requestUrl({
      url: "https://x.test/v1",
      method: "POST",
      contentType: "application/json",
      body: '{"q":1}',
      headers: { Authorization: "Bearer k" },
    });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("application/json");
    expect(r.headers["set-thing"]).toBe("a, b");
    expect(r.json).toEqual({ a: 1 });
    expect(r.text).toBe('{"a":1}');
    expect(ipc.seen[0]).toMatchObject({ method: "POST", body: '{"q":1}' });
    expect(ipc.seen[0].headers).toMatchObject({ "Content-Type": "application/json" });
    expect(await requestUrl("https://x.test").json).toEqual({ a: 1 });
  });

  it("throws on status >= 400 unless throw:false", async () => {
    setNetIpc(fakeIpc({ status: 404, body: enc("no") }));
    await expect(requestUrl("https://x.test")).rejects.toMatchObject({ status: 404 });
    const r = await requestUrl({ url: "https://x.test", throw: false });
    expect(r.status).toBe(404);
    expect(r.text).toBe("no");
  });

  it("is binary-safe both ways", async () => {
    const bytes = new Uint8Array([0, 255, 128, 1]);
    const ipc = fakeIpc({ status: 200, body: bytes });
    setNetIpc(ipc);
    const r = await requestUrl({ url: "https://x.test", method: "PUT", body: bytes.buffer });
    expect(ipc.seen[0].body).toBeUndefined();
    expect(base64ToBytes(ipc.seen[0].body_base64!)).toEqual(bytes);
    expect(new Uint8Array(r.arrayBuffer)).toEqual(bytes);
  });

  it("request() returns text; transport errors become Error", async () => {
    setNetIpc(fakeIpc({ status: 200, body: enc("hi") }));
    expect(await request("https://x.test")).toBe("hi");
    setNetIpc(fakeIpc(new Error("boom")));
    await expect(requestUrl("https://x.test")).rejects.toThrow("Request failed: boom");
  });
});
