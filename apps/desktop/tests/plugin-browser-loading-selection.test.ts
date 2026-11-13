import { describe, expect, test } from "vite-plus/test";
import type { PluginStoreClient, StoreEntry } from "../src/lib/obsidian-host/store-client";
import { createPluginCatalogStore } from "../src/stores/plugin-store-catalog";
import { nextSelectionId } from "../src/components/plugin-browser/list-nav";

const entry = (id: string): StoreEntry => ({
  id,
  name: id,
  author: "me",
  description: "",
  repo: `me/${id}`,
  downloads: 0,
  updated: 0,
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => ((resolve = a), (reject = b)));
  return { promise, resolve, reject };
}

function client(list: PluginStoreClient["list"]): PluginStoreClient {
  return {
    list,
    detail: async (id) => ({
      entry: entry(id),
      readme: "x",
      readme_error: null,
      latest: null,
      release_error: null,
      installed: null,
      update: false,
      audit: null,
    }),
    install: async () => {
      throw new Error("unused");
    },
    uninstall: async () => {},
    state: async () => ({ trusted: true, enabled: [], installed: [] }),
    setEnabled: async () => {},
  };
}

describe("list loading status", () => {
  test("idle -> loading -> ready", async () => {
    const d = deferred<StoreEntry[]>();
    const store = createPluginCatalogStore(client(() => d.promise));
    expect(store.getState().listStatus).toBe("idle");
    const p = store.getState().load();
    expect(store.getState().listStatus).toBe("loading");
    expect(store.getState().entries).toEqual([]);
    d.resolve([entry("a")]);
    await p;
    expect(store.getState().listStatus).toBe("ready");
    expect(store.getState().entries).toHaveLength(1);
  });

  test("idle -> loading -> error, then retry reaches ready", async () => {
    let fail = true;
    const store = createPluginCatalogStore(
      client(async () => {
        if (fail) throw new Error("offline");
        return [entry("a")];
      }),
    );
    await store.getState().load();
    expect(store.getState().listStatus).toBe("error");
    expect(store.getState().listError).toContain("offline");
    fail = false;
    const p = store.getState().load(true);
    expect(store.getState().listStatus).toBe("loading");
    expect(store.getState().listError).toBeNull();
    await p;
    expect(store.getState().listStatus).toBe("ready");
  });

  test("reload keeps loaded rows so a re-open never flashes empty", async () => {
    const store = createPluginCatalogStore(client(async () => [entry("a"), entry("b")]));
    await store.getState().load();
    const d = deferred<StoreEntry[]>();
    const reopened = createPluginCatalogStore(client(() => d.promise));
    reopened.setState({ entries: store.getState().entries, listStatus: "ready" });
    const p = reopened.getState().load();
    expect(reopened.getState().listStatus).toBe("loading");
    expect(reopened.getState().entries).toHaveLength(2);
    d.resolve([entry("a"), entry("b")]);
    await p;
    expect(reopened.getState().entries).toHaveLength(2);
  });
});

describe("selection", () => {
  test("select stores the id synchronously and tracks detail status", async () => {
    const store = createPluginCatalogStore(client(async () => [entry("a")]));
    await store.getState().load();
    const p = store.getState().select("a");
    expect(store.getState().selectedId).toBe("a");
    expect(store.getState().detailStatus).toBe("loading");
    await p;
    expect(store.getState().detailStatus).toBe("ready");
    expect(store.getState().detail?.entry.id).toBe("a");
  });

  test("keyboard navigation", () => {
    const ids = ["a", "b", "c"];
    expect(nextSelectionId(ids, null, "ArrowDown")).toBe("a");
    expect(nextSelectionId(ids, null, "ArrowUp")).toBe("c");
    expect(nextSelectionId(ids, "a", "ArrowDown")).toBe("b");
    expect(nextSelectionId(ids, "c", "ArrowDown")).toBe("c");
    expect(nextSelectionId(ids, "a", "ArrowUp")).toBe("a");
    expect(nextSelectionId(ids, "gone", "ArrowDown")).toBe("a");
    expect(nextSelectionId(ids, "b", "Home")).toBe("a");
    expect(nextSelectionId(ids, "b", "End")).toBe("c");
    expect(nextSelectionId(ids, "b", "x")).toBeNull();
    expect(nextSelectionId([], null, "ArrowDown")).toBeNull();
  });
});
