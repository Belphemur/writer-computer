import { describe, expect, it } from "vite-plus/test";
import { activeHeaderIndex, groupHeaderIndexes, withPinned } from "../web/lib/sticky";

describe("sticky group header selection", () => {
  const items = [
    { kind: "group" },
    { kind: "row" },
    { kind: "row" },
    { kind: "group" },
    { kind: "group-summary" },
    { kind: "row" },
    { kind: "group" },
  ];

  it("finds the group header items", () => {
    expect(groupHeaderIndexes(items)).toEqual([0, 3, 6]);
    expect(groupHeaderIndexes([])).toEqual([]);
    expect(groupHeaderIndexes([{ kind: "row" }])).toEqual([]);
  });

  it("pins the last header at or before the first visible item", () => {
    const headers = [0, 3, 6];
    expect(activeHeaderIndex(headers, 0)).toBe(0);
    expect(activeHeaderIndex(headers, 1)).toBe(0);
    expect(activeHeaderIndex(headers, 2)).toBe(0);
    expect(activeHeaderIndex(headers, 3)).toBe(3);
    expect(activeHeaderIndex(headers, 5)).toBe(3);
    expect(activeHeaderIndex(headers, 6)).toBe(6);
    expect(activeHeaderIndex(headers, 9999)).toBe(6);
  });

  it("has no active header before the first header or without headers", () => {
    expect(activeHeaderIndex([2, 5], 0)).toBeNull();
    expect(activeHeaderIndex([2, 5], 1)).toBeNull();
    expect(activeHeaderIndex([2, 5], 2)).toBe(2);
    expect(activeHeaderIndex([], 4)).toBeNull();
  });

  it("agrees with a linear scan for every position", () => {
    const headers = [0, 4, 5, 11, 40];
    for (let first = 0; first < 60; first++) {
      const linear = [...headers].reverse().find((h) => h <= first) ?? null;
      expect(activeHeaderIndex(headers, first)).toBe(linear);
    }
  });

  it("adds the pinned index to the rendered ones, ascending and once", () => {
    expect(withPinned([10, 11, 12], 3)).toEqual([3, 10, 11, 12]);
    expect(withPinned([2, 3, 4], 3)).toEqual([2, 3, 4]);
    expect(withPinned([10, 11], null)).toEqual([10, 11]);
    expect(withPinned([1, 2, 3], 9)).toEqual([1, 2, 3, 9]);
    expect(withPinned([], 4)).toEqual([4]);
  });
});
