import { describe, expect, test } from "vite-plus/test";
import { createStoreClient, normalizeStoreError, StoreClientError } from "../web/host/store-client";

describe("normalizeStoreError", () => {
  test("strips backend prefixes from string errors", () => {
    const e = normalizeStoreError("plugin_store_install", "IO error: bad checksum");
    expect(e).toBeInstanceOf(StoreClientError);
    expect(e.message).toBe("bad checksum");
    expect(e.command).toBe("plugin_store_install");
  });
  test("handles Error, object and empty values", () => {
    expect(normalizeStoreError("c", new Error("boom")).message).toBe("boom");
    expect(normalizeStoreError("c", { message: "obj" }).message).toBe("obj");
    expect(normalizeStoreError("c", null).message).toBe("c failed");
    expect(normalizeStoreError("c", "").message).toBe("c failed");
  });
  test("is idempotent", () => {
    const e = normalizeStoreError("c", "x");
    expect(normalizeStoreError("other", e)).toBe(e);
  });
});

describe("createStoreClient", () => {
  test("maps methods to commands and args", async () => {
    const calls: [string, unknown][] = [];
    const client = createStoreClient(async (cmd, args) => {
      calls.push([cmd, args]);
      return [];
    });
    await client.list();
    await client.install("a");
    await client.setEnabled("a", true);
    expect(calls).toEqual([
      ["plugin_store_list", { refresh: false }],
      ["plugin_store_install", { id: "a" }],
      ["plugins_set_enabled", { id: "a", enabled: true }],
    ]);
  });
  test("normalizes rejections", async () => {
    const client = createStoreClient(async () => {
      throw "Not found: nope";
    });
    await expect(client.detail("x")).rejects.toMatchObject({
      name: "StoreClientError",
      message: "nope",
    });
  });
});
