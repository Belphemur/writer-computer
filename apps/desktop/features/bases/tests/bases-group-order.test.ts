import { describe, expect, it } from "vite-plus/test";
import {
  entryId,
  entryIsPresent,
  entryLabel,
  entryOfCell,
  groupCandidates,
  sameEntry,
} from "../web/lib/group-order";
import type { Group } from "../web/lib/types";
import { bool, date, link, nul, num, str } from "./helpers/bases-fixtures";

const group = (key: Group["key"]): Group => ({ key, start: 0, len: 1, summaries: [] });

describe("group order entries", () => {
  it("maps scalar group keys to entries and refuses the rest with a reason", () => {
    expect(entryOfCell(str("Open"))).toEqual({ entry: "Open" });
    expect(entryOfCell(num(3))).toEqual({ entry: 3 });
    expect(entryOfCell(bool(true))).toEqual({ entry: true });
    expect(entryOfCell(nul())).toEqual({ entry: null });
    expect(entryOfCell({ type: "number", value: null, display: "NaN" })).toHaveProperty("reason");
    expect(entryOfCell(date("2024-01-01"))).toEqual({
      reason: "date values cannot be ordered by hand",
    });
    expect(entryOfCell(link("A"))).toHaveProperty("reason");
  });

  it("compares like the engine: by value and type, no coercion", () => {
    expect(sameEntry("a", "a")).toBe(true);
    expect(sameEntry(1, "1")).toBe(false);
    expect(sameEntry(null, "null")).toBe(false);
    expect(sameEntry(null, null)).toBe(true);
    expect(sameEntry(true, "true")).toBe(false);
  });

  it("labels entries", () => {
    expect(entryLabel(null)).toBe("No value");
    expect(entryLabel("")).toBe("(empty text)");
    expect(entryLabel("Done")).toBe("Done");
    expect(entryLabel(3)).toBe("3");
    expect(entryLabel(false)).toBe("false");
    expect(entryLabel({ a: 1 })).toBe('{"a":1}');
  });

  it("offers the present groups that are not listed, in display order", () => {
    const groups = [group(str("b")), group(str("a")), group(nul()), group(str("c"))];
    expect(groupCandidates(groups, ["a"]).addable.map((c) => c.entry)).toEqual(["b", null, "c"]);
    expect(groupCandidates(groups, [null, "b"]).addable.map((c) => c.label)).toEqual(["a", "c"]);
    expect(groupCandidates(groups, []).addable).toHaveLength(4);
    expect(groupCandidates(null, []).addable).toEqual([]);
  });

  it("lists values that cannot be ordered instead of hiding them", () => {
    const { addable, blocked } = groupCandidates([group(str("a")), group(date("2024-05-01"))], []);
    expect(addable.map((c) => c.entry)).toEqual(["a"]);
    expect(blocked).toEqual([
      { label: "2024-05-01", reason: "date values cannot be ordered by hand" },
    ]);
  });

  it("tells whether a listed entry matches a current group", () => {
    const groups = [group(str("a")), group(nul())];
    expect(entryIsPresent(groups, "a")).toBe(true);
    expect(entryIsPresent(groups, null)).toBe(true);
    expect(entryIsPresent(groups, "z")).toBe(false);
    expect(entryIsPresent(null, "a")).toBe(false);
  });

  it("gives entries distinct ids", () => {
    const ids = ["1", 1, true, "true", null, "null", ""].map(entryId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
