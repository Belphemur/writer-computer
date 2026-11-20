// The `beforeSave` contribution point (`lib/features/before-save.ts`): registered only while the
// feature is on, run before the save engine serializes a note, a failure contained and a hang not
// waited for.
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));

import {
  BEFORE_SAVE_TIMEOUT_MS,
  beforeSaveContributions,
  runBeforeSave,
} from "@/lib/features/before-save";
import { createFeatureHost, defineFeature } from "@/lib/features/registry";
import { useFeatureHealth } from "@/stores/feature-health-store";

const host = createFeatureHost({ onError: () => {} });

beforeEach(() => {
  useFeatureHealth.setState({ sessionOff: {}, safeMode: false });
});
afterEach(async () => {
  for (const id of host.list()) await host.unregister(id);
  vi.useRealTimers();
});

const feature = (id: string, run: (path: string) => void | Promise<void>) =>
  defineFeature({ id, contributes: { beforeSave: [{ id: `${id}.fix`, run }] } });

describe("beforeSave", () => {
  it("is empty without a feature, and the save does not wait", () => {
    expect(beforeSaveContributions.list()).toEqual([]);
    expect(runBeforeSave("/v/a.md")).toBeNull();
  });

  it("runs every contribution with the note's path and is removed with its feature", async () => {
    const a = vi.fn();
    const b = vi.fn(async () => {});
    host.register(feature("one", a));
    host.register(feature("two", b));
    await runBeforeSave("/v/a.md");
    expect(a).toHaveBeenCalledWith("/v/a.md");
    expect(b).toHaveBeenCalledWith("/v/a.md");
    await host.unregister("one");
    expect(beforeSaveContributions.list().map((c) => c.id)).toEqual(["two.fix"]);
    await host.unregister("two");
    expect(beforeSaveContributions.list()).toEqual([]);
    expect(runBeforeSave("/v/a.md")).toBeNull();
  });

  it("a contribution that throws is reported and the others still run", async () => {
    const ok = vi.fn();
    host.register(
      feature("bad", () => {
        throw new Error("boom");
      }),
    );
    host.register(feature("good", ok));
    await expect(runBeforeSave("/v/a.md")).resolves.toBeUndefined();
    expect(ok).toHaveBeenCalled();
    expect(useFeatureHealth.getState().failures.bad?.count).toBe(1);
  });

  it("a contribution that never answers is not waited for", async () => {
    vi.useFakeTimers();
    host.register(feature("slow", () => new Promise<void>(() => {})));
    let done = false;
    void runBeforeSave("/v/a.md")!.then(() => (done = true));
    await vi.advanceTimersByTimeAsync(BEFORE_SAVE_TIMEOUT_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(done).toBe(true);
  });

  it("rejects an id outside the feature's namespace", () => {
    expect(() =>
      defineFeature({ id: "x", contributes: { beforeSave: [{ id: "y.fix", run: () => {} }] } }),
    ).toThrow(/must start with "x\."/);
  });
});
