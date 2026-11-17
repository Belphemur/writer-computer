import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/lib/preferences", () => ({
  getPreference: vi.fn(async (_k: string, f: unknown) => f),
  setPreference: vi.fn(async () => {}),
}));

import type { PluginStoreClient, StoreDetail } from "../web/host/store-client";
import {
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_CHECK_START_DELAY_MS,
  useUpdatesStore,
  type UpdatesDeps,
} from "../web/stores/plugin-updates-store";
import { useSettingsStore } from "@/stores/settings-store";

const HOURS = 60 * 60 * 1000;
type Versions = Record<string, { installed: string; latest: string | null; fail?: boolean }>;

function plugin(id: string, version: string) {
  return { id, manifest: { id, name: id.toUpperCase(), version } };
}

function setup(versions: Versions) {
  const log: string[] = [];
  let clock = 1_000_000;
  const persisted: Record<string, unknown> = {};
  const state = vi.fn(async () => ({
    trusted: true,
    enabled: [],
    installed: Object.entries(versions).map(([id, v]) => plugin(id, v.installed)),
  }));
  const detail = vi.fn(async (id: string) => {
    log.push(`detail:${id}`);
    const v = versions[id];
    if (v.fail) throw new Error("network down");
    return {
      installed: v.installed,
      latest: v.latest ? { version: v.latest, tag: v.latest, published: null } : null,
      update: v.latest !== null && v.latest !== v.installed,
    } as unknown as StoreDetail;
  });
  const install = vi.fn(async (id: string) => {
    log.push(`install:${id}`);
    if (id === "bad") throw new Error("sha256 mismatch");
    versions[id].installed = versions[id].latest!;
    return {} as never;
  });
  const client = { state, detail, install } as unknown as PluginStoreClient;
  const reconcile = vi.fn(async () => void log.push("reconcile"));
  const deps = {
    client,
    now: () => clock,
    autoEnabled: () => true,
    reconcile,
    load: async () => structuredClone(persisted) as never,
    save: async (c: never) => void Object.assign(persisted, structuredClone(c)),
  };
  useUpdatesStore.getState().configure(deps as unknown as UpdatesDeps);
  return {
    state,
    install,
    client,
    log,
    reconcile,
    persisted,
    advance: (ms: number) => (clock += ms),
    deps,
  };
}

async function fresh(root = "/synthetic") {
  useUpdatesStore.setState({
    root: null,
    status: "idle",
    available: {},
    lastCheckedAt: null,
    checkError: null,
    progress: {},
  });
  await useUpdatesStore.getState().attachRoot(root);
}

beforeEach(() => {
  useSettingsStore.setState({ settings: {} });
});

describe("plugin update checks", () => {
  it("finds plugins with a newer version and records the check time", async () => {
    const t = setup({
      a: { installed: "1.0.0", latest: "1.1.0" },
      b: { installed: "2.0.0", latest: "2.0.0" },
    });
    await fresh();
    await useUpdatesStore.getState().check({ manual: true });
    const s = useUpdatesStore.getState();
    expect(s.available).toEqual({ a: { name: "A", installed: "1.0.0", latest: "1.1.0" } });
    expect(s.lastCheckedAt).toBe(1_000_000);
    expect(s.status).toBe("idle");
    expect(Object.keys(t.persisted)).toEqual(["/synthetic"]);
  });

  it("does not overlap: a second check while one runs is ignored", async () => {
    const t = setup({ a: { installed: "1", latest: "2" } });
    await fresh();
    await Promise.all([
      useUpdatesStore.getState().check({ manual: true }),
      useUpdatesStore.getState().check({ manual: true }),
    ]);
    expect(t.state).toHaveBeenCalledTimes(1);
  });

  it("throttles automatic checks by the stored timestamp but not manual ones", async () => {
    const t = setup({ a: { installed: "1", latest: "2" } });
    await fresh();
    await useUpdatesStore.getState().check();
    await useUpdatesStore.getState().check();
    expect(t.state).toHaveBeenCalledTimes(1);
    t.advance(UPDATE_CHECK_INTERVAL_MS - 1);
    await useUpdatesStore.getState().check();
    expect(t.state).toHaveBeenCalledTimes(1);
    await useUpdatesStore.getState().check({ manual: true });
    expect(t.state).toHaveBeenCalledTimes(2);
    t.advance(UPDATE_CHECK_INTERVAL_MS);
    await useUpdatesStore.getState().check();
    expect(t.state).toHaveBeenCalledTimes(3);
  });

  it("the interval is 3 hours", () => {
    expect(UPDATE_CHECK_INTERVAL_MS).toBe(3 * HOURS);
  });

  it("restores the persisted result for the vault after a restart, so the badge survives", async () => {
    const t = setup({ a: { installed: "1", latest: "2" } });
    await fresh();
    await useUpdatesStore.getState().check({ manual: true });
    useUpdatesStore.setState({ root: null, available: {}, lastCheckedAt: null });
    await useUpdatesStore.getState().attachRoot("/synthetic");
    expect(Object.keys(useUpdatesStore.getState().available)).toEqual(["a"]);
    t.advance(1000);
    await useUpdatesStore.getState().check();
    expect(t.state).toHaveBeenCalledTimes(1);
  });

  it("is silent on automatic failure and does not stamp the check", async () => {
    setup({ a: { installed: "1", latest: "2", fail: true } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await fresh();
    await useUpdatesStore.getState().check();
    expect(useUpdatesStore.getState().checkError).toBeNull();
    expect(useUpdatesStore.getState().lastCheckedAt).toBeNull();
    warn.mockRestore();
  });

  it("surfaces the error of a manual check", async () => {
    setup({ a: { installed: "1", latest: "2", fail: true } });
    await fresh();
    await useUpdatesStore.getState().check({ manual: true });
    expect(useUpdatesStore.getState().checkError).toBe("network down");
    expect(useUpdatesStore.getState().status).toBe("idle");
  });

  it("one plugin missing from the catalog does not fail the check", async () => {
    setup({
      a: { installed: "1", latest: "2" },
      local: { installed: "1", latest: null, fail: true },
    });
    await fresh();
    await useUpdatesStore.getState().check({ manual: true });
    expect(useUpdatesStore.getState().checkError).toBeNull();
    expect(Object.keys(useUpdatesStore.getState().available)).toEqual(["a"]);
  });

  it("automatic checks respect the setting", async () => {
    const t = setup({ a: { installed: "1", latest: "2" } });
    useUpdatesStore
      .getState()
      .configure({ ...(t.deps as unknown as UpdatesDeps), autoEnabled: () => false });
    await fresh();
    await useUpdatesStore.getState().check();
    expect(t.state).not.toHaveBeenCalled();
    await useUpdatesStore.getState().check({ manual: true });
    expect(t.state).toHaveBeenCalledTimes(1);
  });
});

describe("plugin update runs", () => {
  it("updates sequentially, reloading after each install, and never enables anything", async () => {
    const t = setup({ a: { installed: "1", latest: "2" }, b: { installed: "1", latest: "3" } });
    await fresh();
    await useUpdatesStore.getState().check({ manual: true });
    t.log.length = 0;
    await useUpdatesStore.getState().update();
    expect(t.log).toEqual(["install:a", "reconcile", "install:b", "reconcile"]);
    const s = useUpdatesStore.getState();
    expect(s.available).toEqual({});
    expect(s.progress).toEqual({ a: { state: "done" }, b: { state: "done" } });
    expect(s.status).toBe("idle");
    expect(t.client).not.toHaveProperty("setEnabled");
  });

  it("keeps going after a failure and keeps the failed plugin listed", async () => {
    const t = setup({ bad: { installed: "1", latest: "2" }, ok: { installed: "1", latest: "2" } });
    await fresh();
    await useUpdatesStore.getState().check({ manual: true });
    await useUpdatesStore.getState().update();
    const s = useUpdatesStore.getState();
    expect(s.progress.bad).toEqual({ state: "failed", error: "sha256 mismatch" });
    expect(s.progress.ok).toEqual({ state: "done" });
    expect(Object.keys(s.available)).toEqual(["bad"]);
    expect(t.reconcile).toHaveBeenCalledTimes(1);
  });

  it("updates one plugin and ignores a concurrent run", async () => {
    const t = setup({ a: { installed: "1", latest: "2" }, b: { installed: "1", latest: "2" } });
    await fresh();
    await useUpdatesStore.getState().check({ manual: true });
    await Promise.all([
      useUpdatesStore.getState().update(["a"]),
      useUpdatesStore.getState().update(["b"]),
    ]);
    expect(t.install).toHaveBeenCalledTimes(1);
    expect(Object.keys(useUpdatesStore.getState().available)).toEqual(["b"]);
  });
});

describe("scheduler", () => {
  it("checks once after a short delay, then every interval, and stops", async () => {
    vi.useFakeTimers();
    try {
      const t = setup({ a: { installed: "1", latest: "2" } });
      await fresh();
      const stop = useUpdatesStore.getState().startScheduler();
      expect(t.state).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(UPDATE_CHECK_START_DELAY_MS);
      expect(t.state).toHaveBeenCalledTimes(1);
      t.advance(UPDATE_CHECK_INTERVAL_MS);
      await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS);
      expect(t.state).toHaveBeenCalledTimes(2);
      stop();
      t.advance(UPDATE_CHECK_INTERVAL_MS);
      await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS);
      expect(t.state).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
