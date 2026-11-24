// The pure side of the models table and the model chip's list for a live backend.
import { describe, expect, it } from "vite-plus/test";
import { liveModelChoices } from "@features/agent/web/lib/live-models";
import { isModelEnabled, matchesModelQuery, resolveModel } from "@/lib/features/agent-backends";
import {
  filterModels,
  formatContext,
  formatCost,
  providerTabs,
  resolveProvider,
  withEnabled,
} from "../web/lib/models";
import { BACKEND_MODELS as MODELS } from "./fixtures";

describe("models table rules", () => {
  it("a model is enabled unless switched off; the server's own switch comes first", () => {
    expect(isModelEnabled(MODELS[0]!, [])).toBe(true);
    expect(isModelEnabled(MODELS[0]!, ["acme/big-1"])).toBe(false);
    expect(isModelEnabled(MODELS[3]!, [])).toBe(false);
  });

  it("builds the provider tabs from the data, by name, sorted", () => {
    expect(providerTabs(MODELS)).toEqual(["Acme AI", "Zed Labs"]);
    expect(providerTabs([])).toEqual([]);
    expect(providerTabs([...MODELS].reverse())).toEqual(["Acme AI", "Zed Labs"]);
  });

  it("falls back to All when the selected provider is gone", () => {
    expect(resolveProvider("Acme AI", ["Acme AI"])).toBe("Acme AI");
    expect(resolveProvider("Acme AI", ["Zed Labs"])).toBeNull();
    expect(resolveProvider(null, ["Zed Labs"])).toBeNull();
  });

  it("combines the provider, the Enabled and Free chips and the search", () => {
    const none = { provider: null, enabled: false, free: false, query: "", disabled: [] };
    const ids = (o: Partial<typeof none>) =>
      filterModels(MODELS, { ...none, ...o }).map((m) => m.id);
    expect(ids({})).toHaveLength(4);
    expect(ids({ provider: "Acme AI" })).toEqual(["acme/big-1", "acme/small-1"]);
    expect(ids({ free: true })).toEqual(["zed/free-1"]);
    expect(ids({ enabled: true, disabled: ["acme/small-1"] })).toEqual([
      "acme/big-1",
      "zed/free-1",
    ]);
    expect(ids({ provider: "Acme AI", enabled: true, disabled: ["acme/small-1"] })).toEqual([
      "acme/big-1",
    ]);
    expect(ids({ provider: "Acme AI", free: true })).toEqual([]);
    expect(ids({ provider: "Zed Labs", enabled: true, free: true })).toEqual(["zed/free-1"]);
    expect(ids({ provider: "Zed Labs", query: "retired" })).toEqual(["zed/retired-1"]);
    expect(ids({ query: " FREEBIE " })).toEqual(["zed/free-1"]);
  });

  it("one query rule: provider and name, case-insensitive, blank matches all", () => {
    expect(matchesModelQuery("Acme AI", "Big One", " ACME ")).toBe(true);
    expect(matchesModelQuery("Acme AI", "Big One", "one")).toBe(true);
    expect(matchesModelQuery(undefined, "Big One", "acme")).toBe(false);
    expect(matchesModelQuery("Acme AI", "Big One", "  ")).toBe(true);
    expect(matchesModelQuery("Acme AI", "Big One", "zed")).toBe(false);
  });

  it("switching a model writes the list without duplicates", () => {
    expect(withEnabled([], "a/b", false)).toEqual(["a/b"]);
    expect(withEnabled(["a/b"], "a/b", false)).toEqual(["a/b"]);
    expect(withEnabled(["a/b", "c/d"], "a/b", true)).toEqual(["c/d"]);
  });

  it("formats prices and the window", () => {
    expect(formatCost(0.3, false)).toBe("$0.30");
    expect(formatCost(0, true)).toBe("Free");
    expect(formatCost(null, false)).toBe("-");
    expect(formatContext(1_000_000)).toBe("1M");
    expect(formatContext(128_000)).toBe("128K");
    expect(formatContext(null)).toBe("-");
  });
});

describe("the chip's list for a live backend", () => {
  const all = MODELS;

  it("passes the provider and the bare name through, for the menu's groups", () => {
    const row = liveModelChoices(all, []).find((r) => r.id === "acme/big-1")!;
    expect(row).toMatchObject({ provider: "Acme AI", name: "Big One", label: "Big One (Acme AI)" });
  });

  it("lists the enabled, available models and a Default entry first", () => {
    const rows = liveModelChoices(all, ["acme/small-1"]);
    expect(rows.map((r) => r.id)).toEqual(["default", "acme/big-1", "zed/free-1"]);
    expect(rows[0]).toMatchObject({ value: null });
  });

  it("offers only the variants that are in the Effort enum, none without variants", () => {
    const rows = liveModelChoices(all, []);
    const by = (id: string) => rows.find((r) => r.id === id)!;
    expect(by("acme/big-1")).toMatchObject({
      supportsEffort: true,
      efforts: ["low", "high", "max"],
    });
    // `minimal` is not an Effort; `medium` is
    expect(by("zed/free-1").efforts).toEqual(["medium"]);
    expect(by("acme/small-1")).toMatchObject({ supportsEffort: false, efforts: [] });
    // blank follows the first row
    expect(by("default").efforts).toEqual(["low", "high", "max"]);
  });

  it("keeps the chat's current model even when switched off or unknown", () => {
    const off = liveModelChoices(all, ["acme/big-1"], { currentModel: "acme/big-1" });
    expect(off.map((r) => r.id)).toContain("acme/big-1");
    const unknown = liveModelChoices(all, [], { currentModel: "x/y" });
    expect(unknown.find((r) => r.id === "x/y")).toMatchObject({ label: "x/y", efforts: [] });
  });
});
