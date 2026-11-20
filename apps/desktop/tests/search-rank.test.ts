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

  // 3 queries x 6 rankings of up to 10k names: seconds of CPU when the machine is busy.
  test("ranking cost grows linearly with the number of names", { timeout: 60_000 }, () => {
    const make = (n: number) =>
      candidates(
        Array.from({ length: n }, (_, i) => ({
          path: `area-${i % 20}/project-${i % 200}/Note ${i} planning meeting ${
            ["alpha", "Francois Lamarre", "budget", "retro"][i % 4]
          }.md`,
        })),
      ).map((c) => ({ ...c, prepared: prepare(c.path) }));
    const small = make(1_000);
    const large = make(10_000);
    // Median of three runs, small and large measured back to back under the same machine load:
    // no absolute millisecond budget (Rust asserts the 50 ms one), only that 10x the names costs
    // about 10x, not a quadratic blow-up.
    const cost = (cands: typeof small, q: string): number => {
      const times: number[] = [];
      for (let r = 0; r < 3; r++) {
        const t = performance.now();
        const got = rankCandidates(cands, q, { nowMs: NOW, recency: true });
        times.push(performance.now() - t);
        expect(got.length).toBeGreaterThan(0);
      }
      return times.sort((a, b) => a - b)[1]!;
    };
    for (const q of ["planning", "frlam", "francios lamare"]) {
      expect(cost(large, q)).toBeLessThan(cost(small, q) * 10 * 3 + 5);
    }
  });
});

describe("title override as a second name", () => {
  const rec = { openedMs: null, mtimeMs: 0 };

  test("a candidate matches by its file name or its title, never by neither", () => {
    const items = [
      { item: "spec", path: "Notes/Spec.md", title: "Quarterly Plan", recency: rec },
      { item: "zebra", path: "Notes/Zebra.md", title: null, recency: rec },
    ];
    const opts = { nowMs: 0, recency: false };
    expect(rankCandidates(items, "quarterly", opts).map((r) => r.item)).toEqual(["spec"]);
    expect(rankCandidates(items, "spec", opts).map((r) => r.item)).toEqual(["spec"]);
    expect(rankCandidates(items, "zebra", opts).map((r) => r.item)).toEqual(["zebra"]);
    expect(rankCandidates(items, "zzz", opts)).toEqual([]);
  });

  test("the better of the two scores counts, not the sum", () => {
    const opts = { nowMs: 0, recency: false };
    const score = (path: string, title: string | null) =>
      rankCandidates([{ item: "a", path, title, recency: rec }], "plan", opts)[0].score;
    const both = score("Notes/Plan.md", "Plan");
    // the title matches as a file called `Plan.md` (no folder), which beats the nested path
    expect(both).toBe(Math.max(score("Notes/Plan.md", null), score("Plan.md", null)));
  });
});
