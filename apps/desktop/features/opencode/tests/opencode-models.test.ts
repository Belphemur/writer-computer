// The pure side of the models table and the model chip's list for a live backend.
import { describe, expect, it } from "vite-plus/test";
import { liveModelChoices } from "@features/agent/web/lib/live-models";
import { isModelEnabled, resolveModel } from "@/lib/features/agent-backends";
import { filterModels, formatContext, formatCost, withEnabled } from "../web/lib/models";
import { BACKEND_MODELS as MODELS } from "./fixtures";

describe("models table rules", () => {
  it("a model is enabled unless switched off; the server's own switch comes first", () => {
    expect(isModelEnabled(MODELS[0]!, [])).toBe(true);
    expect(isModelEnabled(MODELS[0]!, ["acme/big-1"])).toBe(false);
    expect(isModelEnabled(MODELS[3]!, [])).toBe(false);
  });

  it("filters by tab and by provider or name", () => {
    const ids = (o: Parameters<typeof filterModels>[1]) => filterModels(MODELS, o).map((m) => m.id);
    expect(ids({ tab: "all", query: "", disabled: [] })).toHaveLength(4);
    expect(ids({ tab: "enabled", query: "", disabled: ["acme/small-1"] })).toEqual([
      "acme/big-1",
      "zed/free-1",
    ]);
    expect(ids({ tab: "free", query: "", disabled: [] })).toEqual(["zed/free-1"]);
    expect(ids({ tab: "all", query: "acme", disabled: [] })).toEqual([
      "acme/big-1",
      "acme/small-1",
    ]);
    expect(ids({ tab: "all", query: " FREEBIE ", disabled: [] })).toEqual(["zed/free-1"]);
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
