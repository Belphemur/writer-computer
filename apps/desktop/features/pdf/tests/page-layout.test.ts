// The reader's pure geometry: layout, fit width, the zoom range, which pages draw, which page the
// reader is on, and the reading anchor that survives a change of layout.
import { describe, expect, it } from "vite-plus/test";
import {
  FIT_MARGIN,
  PAGE_GAP,
  ZOOM_MAX,
  ZOOM_MIN,
  anchorAt,
  clampPage,
  clampZoom,
  currentPage,
  fitWidthScale,
  layoutPages,
  renderRange,
  scrollTopOfPage,
  stackWidth,
  yOfAnchor,
} from "../web/lib/page-layout";

const letter = { width: 600, height: 800 };
const pages = (n: number) => Array.from({ length: n }, () => letter);

describe("layout", () => {
  it("stacks pages with a gap above, between and below", () => {
    const l = layoutPages(pages(3), 1);
    expect(l.tops).toEqual([PAGE_GAP, PAGE_GAP + 800 + PAGE_GAP, PAGE_GAP + 2 * (800 + PAGE_GAP)]);
    expect(l.height).toBe(PAGE_GAP + 3 * (800 + PAGE_GAP));
    expect(l.width).toBe(600);
  });

  it("scales the pages, not the gaps, and takes the widest page for the width", () => {
    const l = layoutPages([letter, { width: 800, height: 400 }], 2);
    expect(l.sizes).toEqual([
      { width: 1200, height: 1600 },
      { width: 1600, height: 800 },
    ]);
    expect(l.tops[1]).toBe(PAGE_GAP + 1600 + PAGE_GAP);
    expect(l.width).toBe(1600);
    expect(l.scale).toBe(2);
  });

  it("an empty document has an empty stack", () => {
    const l = layoutPages([], 1);
    expect(l.tops).toEqual([]);
    expect(renderRange(l, 0, 500)).toBeNull();
    expect(currentPage(l, 0, 500)).toBe(1);
    expect(scrollTopOfPage(l, 4)).toBe(0);
  });
});

describe("fit width", () => {
  it("fills the viewer's width inside the margin, widest page first", () => {
    expect(fitWidthScale(pages(2), 632)).toBeCloseTo((632 - 2 * FIT_MARGIN) / 600, 6);
    expect(fitWidthScale([letter, { width: 1200, height: 10 }], 1232)).toBeCloseTo(1, 6);
  });

  it("is 1 before the viewer has a width, and stays inside the zoom range", () => {
    expect(fitWidthScale(pages(1), 0)).toBe(1);
    expect(fitWidthScale([], 500)).toBe(1);
    expect(fitWidthScale(pages(1), 20000)).toBe(ZOOM_MAX);
    expect(fitWidthScale(pages(1), 40)).toBe(ZOOM_MIN);
  });

  it("clamps zooms and ignores garbage", () => {
    expect(clampZoom(100)).toBe(ZOOM_MAX);
    expect(clampZoom(0.001)).toBe(ZOOM_MIN);
    expect(clampZoom(Number.NaN)).toBe(1);
    expect(clampZoom(1.5)).toBe(1.5);
  });

  it("a page wider than the viewer scrolls sideways: the stack grows past the viewer", () => {
    const wide = layoutPages(pages(1), 3); // 1800 wide
    expect(stackWidth(wide, 800)).toBe(1800 + 2 * FIT_MARGIN);
    expect(stackWidth(layoutPages(pages(1), 1), 800)).toBe(800);
  });
});

describe("which pages draw", () => {
  const l = layoutPages(pages(100), 1);
  const at = (page: number) => l.tops[page - 1]!;

  it("only the pages near the viewport, a viewport height ahead and behind", () => {
    const r = renderRange(l, at(50), 800)!;
    expect(r.first).toBeGreaterThanOrEqual(48);
    expect(r.last).toBeLessThanOrEqual(53);
    expect(r.first).toBeLessThanOrEqual(50);
    expect(r.last).toBeGreaterThanOrEqual(50);
    expect(r.last - r.first + 1).toBeLessThan(10);
  });

  it("starts at page 1 and ends at the last page", () => {
    expect(renderRange(l, 0, 800)!.first).toBe(1);
    expect(renderRange(l, l.height, 800)!.last).toBe(100);
  });

  it("a scroll position past the stack (a resize) draws the nearest end", () => {
    expect(renderRange(l, l.height * 3, 800)).toEqual({ first: 100, last: 100 });
  });
});

describe("the page the reader is on", () => {
  const l = layoutPages(pages(10), 1);

  it("is the page under the line a third down the viewport", () => {
    expect(currentPage(l, 0, 900)).toBe(1);
    // the third page's top is one third below the scroll position
    expect(currentPage(l, l.tops[2]! - 300, 900)).toBe(3);
    expect(currentPage(l, l.tops[2]! - 301, 900)).toBe(2);
  });

  it("is the last page once scrolled to the end, even a short one", () => {
    expect(currentPage(l, l.height - 900, 900)).toBe(10);
  });

  it("scrolls a page to the top, clamped to the document", () => {
    expect(scrollTopOfPage(l, 1)).toBe(0);
    expect(scrollTopOfPage(l, 3)).toBe(l.tops[2]! - PAGE_GAP);
    expect(scrollTopOfPage(l, 99)).toBe(l.tops[9]! - PAGE_GAP);
    expect(scrollTopOfPage(l, -4)).toBe(0);
  });

  it("clamps a requested page, null for a non-number", () => {
    expect(clampPage(3, 10)).toBe(3);
    expect(clampPage(0, 10)).toBe(1);
    expect(clampPage(99, 10)).toBe(10);
    expect(clampPage(2.6, 10)).toBe(3);
    expect(clampPage(Number.NaN, 10)).toBeNull();
    expect(clampPage(1, 0)).toBeNull();
  });
});

describe("the reading anchor", () => {
  it("round-trips through the same layout", () => {
    const l = layoutPages(pages(10), 1);
    for (const y of [0, 5, 500, l.tops[4]! + 123, l.height - 10]) {
      expect(yOfAnchor(l, anchorAt(l, y))).toBeCloseTo(Math.max(0, y), 6);
    }
  });

  it("keeps its page and fraction when the scale changes", () => {
    const small = layoutPages(pages(10), 1);
    const big = layoutPages(pages(10), 2);
    const y = small.tops[4]! + 400; // halfway down page 5
    const anchor = anchorAt(small, y);
    expect(anchor.page).toBe(5);
    expect(anchor.frac).toBeCloseTo(0.5, 6);
    expect(yOfAnchor(big, anchor)).toBeCloseTo(big.tops[4]! + 800, 6);
  });

  it("keeps the page when sizes arrive and pages above it grow", () => {
    const before = layoutPages(pages(10), 1);
    const grown = layoutPages([{ width: 600, height: 2000 }, ...pages(9)], 1);
    const anchor = anchorAt(before, before.tops[6]!);
    expect(anchor.page).toBe(7);
    expect(yOfAnchor(grown, anchor)).toBe(grown.tops[6]!);
  });
});
