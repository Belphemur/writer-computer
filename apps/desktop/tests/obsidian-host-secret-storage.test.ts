// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { SecretStorage, type SecretBackend } from "../src/lib/obsidian-host/api/secret-storage";

function fakeBackend(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const calls: string[] = [];
  const backend: SecretBackend = {
    secretsLoad: async () => Object.fromEntries(store),
    secretSet: async (id, secret) => {
      calls.push(`set:${id}=${secret}`);
      store.set(id, secret);
    },
    secretDelete: async (id) => {
      calls.push(`delete:${id}`);
      store.delete(id);
    },
  };
  return { backend, store, calls };
}

function errorLog(): { phase: string; message: string }[] {
  return ((window as any).__writerPluginErrors ?? []) as { phase: string; message: string }[];
}

afterEach(() => {
  vi.restoreAllMocks();
  (window as any).__writerPluginErrors = [];
});

describe("SecretStorage", () => {
  it("stores, lists and deletes secrets synchronously with no backend", () => {
    const s = new SecretStorage();
    expect(s.getSecret("a")).toBeNull();
    s.setSecret("a", "1");
    s.setSecret("b", "2");
    expect(s.getSecret("a")).toBe("1");
    expect(s.listSecrets()).toEqual(["a", "b"]);
    s.deleteSecret("a");
    expect(s.getSecret("a")).toBeNull();
  });

  it("hydrate loads persisted secrets, once", async () => {
    const { backend } = fakeBackend({ k: "v" });
    const load = vi.spyOn(backend, "secretsLoad");
    const s = new SecretStorage();
    await Promise.all([s.hydrate(backend), s.hydrate(backend)]);
    await s.hydrate(backend);
    expect(s.getSecret("k")).toBe("v");
    expect(s.listSecrets()).toEqual(["k"]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("writes reach the backend in order, and deletes too", async () => {
    const { backend, calls, store } = fakeBackend();
    const s = new SecretStorage();
    await s.hydrate(backend);
    s.setSecret("a", "1");
    s.setSecret("a", "2");
    s.deleteSecret("a");
    s.setSecret("b", "3");
    expect(s.getSecret("a")).toBeNull(); // sync, before the backend has run
    await s.flush();
    expect(calls).toEqual(["set:a=1", "set:a=2", "delete:a", "set:b=3"]);
    expect([...store.entries()]).toEqual([["b", "3"]]);
  });

  it("records a hydrate failure and stays usable in memory", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { backend } = fakeBackend();
    backend.secretsLoad = async () => {
      throw new Error("no secret service");
    };
    const s = new SecretStorage();
    await expect(s.hydrate(backend)).resolves.toBeUndefined();
    s.setSecret("a", "1");
    expect(s.getSecret("a")).toBe("1");
    expect(
      errorLog().some((e) => e.phase === "hydrate" && /no secret service/.test(e.message)),
    ).toBe(true);
  });

  it("records a write failure, keeps the value and keeps writing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { backend, calls } = fakeBackend();
    const inner = { ...backend };
    backend.secretSet = async (id, secret) => {
      if (id === "bad") throw new Error("keychain locked");
      return inner.secretSet(id, secret);
    };
    const s = new SecretStorage();
    await s.hydrate(backend);
    s.setSecret("bad", "x");
    s.setSecret("good", "y");
    await s.flush();
    expect(s.getSecret("bad")).toBe("x");
    expect(calls).toEqual(["set:good=y"]);
    expect(errorLog().some((e) => e.phase === "set:bad" && /keychain locked/.test(e.message))).toBe(
      true,
    );
  });

  it("does not clobber a value set while hydrate is in flight", async () => {
    const { backend, store, calls } = fakeBackend({ a: "old", b: "kept", gone: "z" });
    const s = new SecretStorage();
    const hydrating = s.hydrate(backend);
    s.setSecret("a", "new");
    s.deleteSecret("gone");
    await hydrating;
    await s.flush();
    expect(s.getSecret("a")).toBe("new");
    expect(s.getSecret("b")).toBe("kept");
    expect(s.getSecret("gone")).toBeNull();
    expect(calls).toEqual(["set:a=new", "delete:gone"]);
    expect(store.get("a")).toBe("new");
  });

  it("reports unavailable on a denied keychain, then retry fills the cache and notifies", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { backend, store } = fakeBackend({ k: "v" });
    const load = backend.secretsLoad;
    let deny = true;
    backend.secretsLoad = async () => {
      if (deny) throw new Error("User canceled the authorization");
      return load();
    };
    const s = new SecretStorage();
    const seen = vi.fn();
    s.subscribe(seen);
    await s.hydrate(backend);
    expect(s.status).toEqual({ state: "unavailable", reason: "User canceled the authorization" });
    expect(s.getSecret("k")).toBeNull();
    // a write while unavailable is not sent to the store (no partial overwrite) and is logged
    s.setSecret("new", "n");
    await s.flush();
    expect(store.has("new")).toBe(false);
    expect(errorLog().some((e) => e.phase === "set:new")).toBe(true);
    deny = false;
    await s.retry();
    await s.flush();
    expect(s.status).toEqual({ state: "ready" });
    expect(s.getSecret("k")).toBe("v");
    expect(s.getSecret("new")).toBe("n");
    expect(store.get("new")).toBe("n"); // replayed after the successful read
    expect(seen).toHaveBeenCalled();
  });

  it("retry stays unavailable when the keychain still fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { backend } = fakeBackend();
    backend.secretsLoad = async () => {
      throw new Error("locked");
    };
    const s = new SecretStorage();
    await s.hydrate(backend);
    expect((await s.retry()).state).toBe("unavailable");
  });
});
