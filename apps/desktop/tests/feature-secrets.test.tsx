// @vitest-environment jsdom
// A feature's secrets: the set / not set rows (the "Secrets" group of its Settings page) and the
// scoped `ctx.secrets`. The IPC is faked with the same scope rule Rust enforces.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../src/lib/tauri", () => ({ confirmAction: vi.fn(async () => true) }));

import { FeatureSecretRows } from "../src/components/settings-panel/feature-secret-rows";
import fixtureManifest from "../src-tauri/tests/fixtures/features/fixture-secrets/feature.json";
import type { FeatureManifest } from "../src/lib/features/types";
import { createFeatureHost } from "../src/lib/features/registry";
import { confirmAction } from "../src/lib/tauri";
import {
  featureSecrets,
  setFeatureSecretsClient,
  useFeatureSecretsStore,
} from "../src/stores/feature-secrets-store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WITH_SECRET = fixtureManifest as FeatureManifest;
const KEY = "features.fixture-secrets.api-token";
const VALUE = "synthetic-ui-secret-98765";

let stored: Map<string, string>;
const calls: string[] = [];
let container: HTMLElement;
let root: Root;

/** Mirrors `features::secrets`: a feature reaches only the keys its own manifest declares. */
function declares(id: string, key: string): boolean {
  return id === WITH_SECRET.id && key === KEY;
}
function guard(id: string, key: string) {
  if (!declares(id, key)) throw new Error(`EINVAL: feature ${id} declares no secret ${key}`);
}

beforeEach(async () => {
  stored = new Map();
  calls.length = 0;
  setFeatureSecretsClient({
    keysSet: async (id: string) => [...stored.keys()].filter((k) => declares(id, k)),
    get: async (id: string, key: string) => (guard(id, key), stored.get(key) ?? null),
    set: async (id: string, key: string, v: string) => {
      guard(id, key);
      calls.push(`set ${key}`);
      stored.set(key, v);
    },
    delete: async (id: string, key: string) => {
      guard(id, key);
      calls.push(`delete ${key}`);
      stored.delete(key);
    },
  });
  useFeatureSecretsStore.setState({ keysSet: {}, errors: {}, busy: false });
  vi.mocked(confirmAction).mockResolvedValue(true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <FeatureSecretRows featureId={WITH_SECRET.id} secrets={WITH_SECRET.contributes!.secrets!} />,
    ),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const refresh = () => act(() => useFeatureSecretsStore.getState().refresh(WITH_SECRET.id));
const button = (label: string) =>
  container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const status = () => container.querySelector("[data-secret-status]")!.textContent;

async function type(el: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("a secret row", () => {
  it("shows not set, then set after saving, and never shows the value", async () => {
    expect(status()).toBe("Not set");
    expect(button("Clear API token")).toBeNull();

    await act(async () => button("Set API token")!.click());
    const field = container.querySelector<HTMLInputElement>(
      'input[aria-label="New value for API token"]',
    )!;
    expect(field.type).toBe("password");
    await type(field, VALUE);
    await act(async () =>
      [...container.querySelectorAll("button")].find((b) => b.textContent === "Save")!.click(),
    );

    expect(stored.get(KEY)).toBe(VALUE);
    expect(status()).toBe("Set");
    // the value is nowhere in the page, and the typed field was closed and cleared
    expect(container.innerHTML).not.toContain(VALUE);
    expect(container.querySelector("input")).toBeNull();
    expect(button("Replace API token")).toBeTruthy();
  });

  it("clears a set secret after confirming", async () => {
    stored.set(KEY, VALUE);
    await refresh();
    expect(status()).toBe("Set");
    await act(async () => button("Clear API token")!.click());
    expect(confirmAction).toHaveBeenCalled();
    expect(calls).toContain(`delete ${KEY}`);
    expect(stored.has(KEY)).toBe(false);
    expect(status()).toBe("Not set");
  });

  it("keeps the secret when the clear is not confirmed", async () => {
    stored.set(KEY, VALUE);
    await refresh();
    vi.mocked(confirmAction).mockResolvedValue(false);
    await act(async () => button("Clear API token")!.click());
    expect(stored.has(KEY)).toBe(true);
    expect(status()).toBe("Set");
  });
});

describe("ctx.secrets", () => {
  it("reads, writes and deletes the feature's own key", async () => {
    const secrets = featureSecrets(WITH_SECRET.id);
    expect(await secrets.get(KEY)).toBeNull();
    await secrets.set(KEY, VALUE);
    expect(await secrets.get(KEY)).toBe(VALUE);
    expect(useFeatureSecretsStore.getState().keysSet[WITH_SECRET.id]).toEqual([KEY]);
    await secrets.delete(KEY);
    expect(await secrets.get(KEY)).toBeNull();
  });

  it("rejects another feature's key and an undeclared one", async () => {
    stored.set(KEY, VALUE);
    const other = featureSecrets("other-feature");
    await expect(other.get(KEY)).rejects.toThrow(/declares no secret/);
    await expect(other.set(KEY, "x")).rejects.toThrow(/declares no secret/);
    await expect(other.delete(KEY)).rejects.toThrow(/declares no secret/);
    const own = featureSecrets(WITH_SECRET.id);
    await expect(own.get("features.fixture-secrets.undeclared")).rejects.toThrow();
    await expect(own.set("features.fixture-secrets.undeclared", "x")).rejects.toThrow();
    expect(stored.get(KEY)).toBe(VALUE);
  });

  it("is on the context the host hands a feature, scoped to its id", async () => {
    const host = createFeatureHost({ onError: () => {}, onFailure: () => {} });
    let seen: { secrets: { get(key: string): Promise<string | null> } } | undefined;
    host.register({
      id: WITH_SECRET.id,
      activate: (ctx) => {
        seen = ctx;
      },
    });
    await host.activate(WITH_SECRET.id);
    stored.set(KEY, VALUE);
    expect(await seen!.secrets.get(KEY)).toBe(VALUE);
  });
});
