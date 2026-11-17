import { describe, expect, test } from "vite-plus/test";
import type {
  PluginStoreClient,
  StoreDetail,
  StoreEntry,
  StorePluginsState,
} from "../web/host/store-client";
import { createPluginCatalogStore, selectVisibleEntries } from "../web/stores/plugin-store-catalog";

const entry = (id: string, over: Partial<StoreEntry> = {}): StoreEntry => ({
  id,
  name: id,
  author: "me",
  description: `desc ${id}`,
  repo: `me/${id}`,
  downloads: 0,
  updated: 0,
  ...over,
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => ((resolve = a), (reject = b)));
  return { promise, resolve, reject };
}

const detailOf = (e: StoreEntry, over: Partial<StoreDetail> = {}): StoreDetail => ({
  entry: e,
  readme: "# hi",
  readme_error: null,
  latest: { version: "2.0.0", tag: "2.0.0", published: null },
  release_error: null,
  installed: null,
  update: false,
  audit: null,
  ...over,
});

function fakeClient(over: Partial<PluginStoreClient> = {}) {
  const st: StorePluginsState = { trusted: true, enabled: [], installed: [] };
  const entries = [entry("a"), entry("b")];
  const client: PluginStoreClient = {
    list: async () => entries,
    detail: async (id) => detailOf(entries.find((e) => e.id === id)!),
    install: async (id) => {
      st.installed.push({ id, manifest: { id, version: "1.0.0" } as never });
      return { by: "", id, repo: "", version: "1.0.0", tag: "", installed_at: 0, files: {} };
    },
    uninstall: async (id) => {
      st.installed = st.installed.filter((p) => p.id !== id);
    },
    state: async () => ({ ...st }),
    setEnabled: async (id, on) => {
      st.enabled = on ? [id] : [];
    },
    ...over,
  };
  return client;
}

describe("selectVisibleEntries", () => {
  const entries = [
    entry("zed", { name: "Zed", downloads: 5, updated: 10 }),
    entry("alpha", { name: "Alpha", downloads: 50, updated: 5, author: "Bob" }),
    entry("mid", { name: "Mid", downloads: 50, updated: 20, description: "Calendar tool" }),
  ];
  const base = { entries, search: "", sort: "downloads" as const, filter: "all" as const };
  const maps = { installedVersions: {}, updatable: {} };

  test("sorts by downloads with name tie-break, updated, name", () => {
    const ids = (sort: "downloads" | "updated" | "name") =>
      selectVisibleEntries({ ...base, ...maps, sort }).map((e) => e.id);
    expect(ids("downloads")).toEqual(["alpha", "mid", "zed"]);
    expect(ids("updated")).toEqual(["mid", "zed", "alpha"]);
    expect(ids("name")).toEqual(["alpha", "mid", "zed"]);
  });
  test("searches name, author, description case-insensitively", () => {
    const q = (search: string) =>
      selectVisibleEntries({ ...base, ...maps, search }).map((e) => e.id);
    expect(q("bob")).toEqual(["alpha"]);
    expect(q("CALENDAR")).toEqual(["mid"]);
    expect(q("nothing")).toEqual([]);
  });
  test("filters installed and updatable", () => {
    const installedVersions = { zed: "1", mid: "1" };
    const updatable = { mid: true, alpha: true };
    const f = (filter: "installed" | "updatable") =>
      selectVisibleEntries({ ...base, installedVersions, updatable, filter }).map((e) => e.id);
    expect(f("installed")).toEqual(["mid", "zed"]);
    expect(f("updatable")).toEqual(["mid"]);
  });
});

describe("catalog store", () => {
  test("load success and error", async () => {
    const store = createPluginCatalogStore(fakeClient());
    await store.getState().load();
    expect(store.getState().listStatus).toBe("ready");
    expect(store.getState().entries).toHaveLength(2);

    const bad = createPluginCatalogStore(
      fakeClient({ list: async () => Promise.reject(new Error("offline")) }),
    );
    await bad.getState().load();
    expect(bad.getState().listStatus).toBe("error");
    expect(bad.getState().listError).toBe("offline");
  });

  test("drops stale list responses", async () => {
    const first = deferred<StoreEntry[]>();
    let n = 0;
    const store = createPluginCatalogStore(
      fakeClient({ list: () => (n++ === 0 ? first.promise : Promise.resolve([entry("fresh")])) }),
    );
    const p1 = store.getState().load();
    await store.getState().load(true);
    first.resolve([entry("stale")]);
    await p1;
    expect(store.getState().entries.map((e) => e.id)).toEqual(["fresh"]);
  });

  test("drops stale detail responses when selection changes", async () => {
    const slow = deferred<StoreDetail>();
    const store = createPluginCatalogStore(
      fakeClient({
        detail: (id) => (id === "a" ? slow.promise : Promise.resolve(detailOf(entry(id)))),
      }),
    );
    const pa = store.getState().select("a");
    await store.getState().select("b");
    slow.resolve(detailOf(entry("a")));
    await pa;
    expect(store.getState().selectedId).toBe("b");
    expect(store.getState().detail?.entry.id).toBe("b");
  });

  test("detail error is surfaced", async () => {
    const store = createPluginCatalogStore(
      fakeClient({ detail: async () => Promise.reject(new Error("rate limited")) }),
    );
    await store.getState().select("a");
    expect(store.getState().detailStatus).toBe("error");
    expect(store.getState().detailError).toBe("rate limited");
  });

  test("install flow: busy, then installed but not enabled", async () => {
    const gate = deferred<void>();
    const base = fakeClient();
    const store = createPluginCatalogStore({
      ...base,
      install: async (id: string) => {
        await gate.promise;
        return base.install(id);
      },
    });
    await store.getState().load();
    await store.getState().select("a");
    const p = store.getState().install("a");
    expect(store.getState().busy.a).toBe("installing");
    // A second click while busy is ignored.
    expect(await store.getState().install("a")).toBe(false);
    gate.resolve();
    expect(await p).toBe(true);
    const s = store.getState();
    expect(s.busy.a).toBeUndefined();
    expect(s.installedVersions.a).toBe("1.0.0");
    expect(s.enabledIds).toEqual([]);

    expect(await s.setEnabled("a", true)).toBe(true);
    expect(store.getState().enabledIds).toEqual(["a"]);
    expect(await store.getState().uninstall("a")).toBe(true);
    expect(store.getState().installedVersions.a).toBeUndefined();
  });

  test("install failure keeps the error and clears busy", async () => {
    const store = createPluginCatalogStore(
      fakeClient({ install: async () => Promise.reject(new Error("checksum mismatch")) }),
    );
    await store.getState().load();
    expect(await store.getState().install("a")).toBe(false);
    expect(store.getState().busy.a).toBeUndefined();
    expect(store.getState().actionError.a).toBe("checksum mismatch");
    store.getState().clearActionError("a");
    expect(store.getState().actionError.a).toBeUndefined();
    // A retry clears the previous error.
    store.getState().clearActionError("a");
  });

  test("update flag learned from detail feeds the updatable filter", async () => {
    const base = fakeClient();
    const store = createPluginCatalogStore({
      ...base,
      state: async () => ({
        trusted: false,
        enabled: [],
        installed: [{ id: "a", manifest: { id: "a", version: "1.0.0" } as never }],
      }),
      detail: async (id: string) => detailOf(entry(id), { update: id === "a", installed: "1.0.0" }),
    });
    await store.getState().load();
    await new Promise((r) => setTimeout(r, 0));
    store.getState().setFilter("updatable");
    expect(selectVisibleEntries(store.getState()).map((e) => e.id)).toEqual(["a"]);
    expect(store.getState().trusted).toBe(false);
  });
});
