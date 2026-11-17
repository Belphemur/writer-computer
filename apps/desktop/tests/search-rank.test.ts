import { describe, expect, test } from "vite-plus/test";
import vectors from "../shared/search-rank-vectors.json";
import {
  originalIndices,
  matchPath,
  prepare,
  prepareQuery,
  rankCandidates,
  recencyBoost,
  type Candidate,
} from "../src/lib/search-rank";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

interface Entry {
  path: string;
  opened_days_ago?: number;
  modified_days_ago?: number;
}
interface Vector {
  name: string;
  query: string;
  entries: Entry[];
  recency?: boolean;
  expect: string[];
}

function candidates(entries: Entry[]): Candidate<string>[] {
  return entries.map((e) => ({
    item: e.path,
    path: e.path,
    recency: {
      openedMs: e.opened_days_ago === undefined ? null : NOW - e.opened_days_ago * DAY,
      mtimeMs: NOW - (e.modified_days_ago ?? 10_000) * DAY,
    },
  }));
}

describe("search ranking: shared vectors (same file as rank.rs)", () => {
  for (const v of vectors as Vector[]) {
    test(v.name, () => {
      const got = rankCandidates(candidates(v.entries), v.query, {
        nowMs: NOW,
        recency: v.recency ?? true,
      }).map((r) => r.item);
      expect(got).toEqual(v.expect);
    });
  }
});

describe("search ranking: extras", () => {
  const rank = (entries: Entry[], query: string, recency = true) =>
    rankCandidates(candidates(entries), query, { nowMs: NOW, recency }).map((r) => r.item);

  test("empty query lists opened files first, then newest modified, deterministically", () => {
    const got = rank(
      [
        { path: "z.md", modified_days_ago: 1 },
        { path: "b.md", modified_days_ago: 50, opened_days_ago: 2 },
        { path: "a.md", modified_days_ago: 50, opened_days_ago: 0.5 },
        { path: "m.md", modified_days_ago: 1 },
      ],
      "",
    );
    expect(got).toEqual(["a.md", "b.md", "m.md", "z.md"]);
  });

  test("highlight indices point into the original string, NFC or NFD", () => {
    const path = "People/François Lamarre.md";
    const m = matchPath(prepareQuery("lamarre"), prepare(path))!;
    const idx = originalIndices(path, m.folded);
    expect(idx.map((i) => Array.from(path)[i]).join("")).toBe("Lamarre");
  });

  test("recency boost halves per half-life and is bounded", () => {
    expect(recencyBoost(NOW, { openedMs: NOW, mtimeMs: NOW })).toBeCloseTo(0.8);
    expect(recencyBoost(NOW, { openedMs: NOW - 3 * DAY })).toBeCloseTo(0.25);
    expect(recencyBoost(NOW, { mtimeMs: NOW - 400 * DAY })).toBeLessThan(0.001);
  });

  test("ten thousand synthetic names rank within the interactive budget", () => {
    const entries: Entry[] = Array.from({ length: 10_000 }, (_, i) => ({
      path: `area-${i % 20}/project-${i % 200}/Note ${i} planning meeting ${
        ["alpha", "Francois Lamarre", "budget", "retro"][i % 4]
      }.md`,
    }));
    const cands = candidates(entries).map((c) => ({ ...c, prepared: prepare(c.path) }));
    for (const q of ["planning", "frlam", "francios lamare"]) {
      const t = performance.now();
      const got = rankCandidates(cands, q, { nowMs: NOW, recency: true });
      expect(got.length).toBeGreaterThan(0);
      expect(performance.now() - t).toBeLessThan(500); // generous: CI noise; Rust asserts 50 ms
    }
  });
});
