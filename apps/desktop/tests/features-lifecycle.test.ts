// Starting and stopping features live, web half (ADR 2026-11-20): the Rust handshake, the `ctx`
// helpers that release everything on deactivate, and a cycle over every built-in feature.
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));

import { BUILTIN_FEATURES, syncBuiltinFeatures } from "../src/lib/features/builtin";
import { createFeatureHost, defineFeature, featureHost } from "../src/lib/features/registry";
import type { FeatureContext } from "../src/lib/features/types";
import { create } from "zustand";
import { flushPromises } from "@tests/helpers/events";

afterEach(() => void vi.useRealTimers());

function hostWithListens() {
  const listens: { name: string; un: ReturnType<typeof vi.fn> }[] = [];
  const host = createFeatureHost({
    onError: () => {},
    listen: (async (name: string) => {
      const un = vi.fn();
      listens.push({ name, un });
      return un;
    }) as never,
  });
  return { host, listens };
}

describe("the Rust handshake", () => {
  const rustManifest = {
    id: "demo-rust",
    enabledByDefault: true,
    rust: { commands: ["demo_cmd"] },
  };
  const webManifest = { id: "demo-web", enabledByDefault: true };
  const features = [
    { manifest: rustManifest, definition: defineFeature({ id: "demo-rust" }) },
    { manifest: webManifest, definition: defineFeature({ id: "demo-web" }) },
  ];

  it("registers a feature with a Rust half only once it is started, and drops it when stopped", async () => {
    const { host } = hostWithListens();
    let started = false;
    const sync = () =>
      syncBuiltinFeatures(
        host,
        features,
        {},
        () => false,
        () => false,
        (id) => (id === "demo-rust" ? started : true),
      );
    sync();
    expect(host.list()).toEqual(["demo-web"]);
    started = true;
    sync();
    expect(host.list().sort()).toEqual(["demo-rust", "demo-web"]);
    started = false;
    sync();
    await flushPromises();
    expect(host.list()).toEqual(["demo-web"]);
  });
});

describe("ctx releases everything on deactivate", () => {
  it("clears timers, store subscriptions and onDispose callbacks, and the listener", async () => {
    vi.useFakeTimers();
    const { host, listens } = hostWithListens();
    const store = create<{ n: number }>()(() => ({ n: 0 }));
    const seen: number[] = [];
    const disposed = vi.fn();
    const ticks = vi.fn();
    host.register(
      defineFeature({
        id: "owner",
        activate: (ctx) => {
          ctx.setTimeout(() => ticks("once"), 1000);
          ctx.setInterval(() => ticks("every"), 100);
          ctx.subscribe(store, (s) => seen.push(s.n));
          ctx.onDispose(disposed);
          ctx.listen("event", () => {});
        },
      }),
    );
    await host.activate("owner");
    store.setState({ n: 1 });
    vi.advanceTimersByTime(250);
    expect(seen).toEqual([1]);
    expect(ticks).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(2);

    await host.deactivate("owner");
    expect(disposed).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    store.setState({ n: 2 });
    vi.advanceTimersByTime(5000);
    expect(seen).toEqual([1]);
    expect(ticks).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(listens[0]!.un).toHaveBeenCalledOnce());
  });
});

describe("ctx timers", () => {
  it("a one-shot timer drops its disposer when it fires, so the store does not grow", async () => {
    vi.useFakeTimers();
    const sizes: number[] = [];
    let ctxOf!: FeatureContext;
    const { host } = hostWithListens();
    host.register(
      defineFeature({
        id: "ticker",
        activate: (ctx) => {
          ctxOf = ctx;
        },
      }),
    );
    await host.activate("ticker");
    const base = ctxOf.disposables.size;
    for (let i = 0; i < 5; i++) {
      ctxOf.setTimeout(() => sizes.push(ctxOf.disposables.size), 10);
      expect(ctxOf.disposables.size).toBe(base + 1);
      vi.advanceTimersByTime(10);
      expect(ctxOf.disposables.size).toBe(base);
    }
    // inside its own callback the timer is already released
    expect(sizes).toEqual([base, base, base, base, base]);
    // a cancelled one leaves no timer and no entry either
    const stop = ctxOf.setTimeout(() => sizes.push(-1), 10);
    stop();
    expect(ctxOf.disposables.size).toBe(base);
    expect(vi.getTimerCount()).toBe(0);
    // an interval stays until it is disposed
    const every = ctxOf.setInterval(() => {}, 10);
    vi.advanceTimersByTime(50);
    expect(ctxOf.disposables.size).toBe(base + 1);
    every();
    expect(ctxOf.disposables.size).toBe(base);
    await host.deactivate("ticker");
  });
});

describe("every built-in feature", () => {
  it("activates and deactivates twice and leaves no timer or disposable behind", async () => {
    // the loader (`builtin.ts`) registered them on the app's host when it was imported
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval"] });
    for (const { manifest } of BUILTIN_FEATURES) {
      if (featureHost.state(manifest.id) === undefined) continue; // off by default or rust-only
      const timersBefore = vi.getTimerCount();
      for (let round = 1; round <= 2; round++) {
        await featureHost.activate(manifest.id).catch(() => {});
        if (featureHost.state(manifest.id) !== "active") break; // a failed activation is the host's concern
        await featureHost.deactivate(manifest.id);
        for (let i = 0; i < 10; i++) await Promise.resolve();
        expect(featureHost.state(manifest.id), `${manifest.id} round ${round}`).toBe("registered");
        expect(
          vi.getTimerCount(),
          `${manifest.id} round ${round}: a timer outlived deactivate`,
        ).toBe(timersBefore);
      }
    }
  });
});
