import { describe, expect, it } from "vite-plus/test";
import {
  clampShift,
  computePopupPosition,
  fitsViewport,
  pointRect,
  type Rect,
} from "../src/lib/popup-position";

const vp = { width: 1000, height: 800 };
const anchor = (top: number, left = 100, height = 20, width = 50): Rect => ({
  top,
  left,
  right: left + width,
  bottom: top + height,
});
const popup = (height: number, width = 300) => ({ width, height });

describe("computePopupPosition", () => {
  it("opens below when it fits", () => {
    const r = computePopupPosition({
      anchorRect: anchor(100),
      popupSize: popup(200),
      viewport: vp,
    });
    expect(r.placement).toBe("below");
    expect(r.top).toBe(124); // bottom 120 + gap 4
    expect(r.maxHeight).toBe(200);
  });

  it("opens above when below is cramped and above has room", () => {
    const r = computePopupPosition({
      anchorRect: anchor(700),
      popupSize: popup(200),
      viewport: vp,
    });
    expect(r.placement).toBe("above");
    expect(r.top).toBe(700 - 4 - 200);
    expect(r.top + r.maxHeight).toBeLessThanOrEqual(700);
  });

  it("honors preferred=above and flips below when above is cramped", () => {
    const ok = computePopupPosition({
      anchorRect: anchor(400),
      popupSize: popup(100),
      viewport: vp,
      preferred: "above",
    });
    expect(ok.placement).toBe("above");
    const flipped = computePopupPosition({
      anchorRect: anchor(30),
      popupSize: popup(100),
      viewport: vp,
      preferred: "above",
    });
    expect(flipped.placement).toBe("below");
  });

  it("picks the larger side and caps maxHeight when neither fits", () => {
    const r = computePopupPosition({
      anchorRect: anchor(500),
      popupSize: popup(700),
      viewport: vp,
    });
    // below: 800-8-524 = 268, above: 500-4-8 = 488
    expect(r.placement).toBe("above");
    expect(r.maxHeight).toBe(488);
    expect(r.top).toBe(8);
    const below = computePopupPosition({
      anchorRect: anchor(200),
      popupSize: popup(900),
      viewport: vp,
    });
    expect(below.placement).toBe("below");
    expect(below.maxHeight).toBe(800 - 8 - 224);
    expect(below.top + below.maxHeight).toBe(792);
  });

  it("clamps horizontally at the right and left edges", () => {
    const right = computePopupPosition({
      anchorRect: anchor(100, 900),
      popupSize: popup(50, 300),
      viewport: vp,
    });
    expect(right.left).toBe(1000 - 8 - 300);
    const left = computePopupPosition({
      anchorRect: anchor(100, -50),
      popupSize: popup(50, 300),
      viewport: vp,
    });
    expect(left.left).toBe(8);
  });

  it("handles an anchor partly offscreen by pinning inside the viewport", () => {
    const top = computePopupPosition({
      anchorRect: anchor(-100, 100, 20),
      popupSize: popup(200),
      viewport: vp,
    });
    expect(top.placement).toBe("below"); // room below the offscreen anchor
    const bottomOff = computePopupPosition({
      anchorRect: anchor(790, 100, 40),
      popupSize: popup(300),
      viewport: vp,
    });
    expect(bottomOff.placement).toBe("above");
    expect(bottomOff.top).toBeGreaterThanOrEqual(8);
    const both = computePopupPosition({
      anchorRect: { top: -400, bottom: 1200, left: 10, right: 20 },
      popupSize: popup(300),
      viewport: vp,
    });
    expect(both.placement).toBe("overlay");
    expect(both.top).toBeGreaterThanOrEqual(8);
    expect(both.top + both.maxHeight).toBeLessThanOrEqual(792);
  });

  it("shrinks a popup bigger than the viewport", () => {
    const r = computePopupPosition({
      anchorRect: anchor(100),
      popupSize: { width: 2000, height: 2000 },
      viewport: vp,
    });
    expect(r.maxWidth).toBe(984);
    expect(r.left).toBe(8);
    expect(r.top + r.maxHeight).toBeLessThanOrEqual(792);
    expect(r.top).toBeGreaterThanOrEqual(8);
  });

  it("copes with tiny viewports", () => {
    const r = computePopupPosition({
      anchorRect: pointRect(5, 5),
      popupSize: popup(200, 200),
      viewport: { width: 20, height: 20 },
    });
    expect(r.maxHeight).toBeGreaterThanOrEqual(0);
    expect(r.maxWidth).toBe(4);
    expect(Number.isFinite(r.top) && Number.isFinite(r.left)).toBe(true);
  });

  it("keeps the previous side while it still fits (no jitter), flips when it stops fitting", () => {
    const base = { anchorRect: anchor(300), viewport: vp, previous: "above" as const };
    // below would also fit; above was current and still fits: stay
    expect(computePopupPosition({ ...base, popupSize: popup(100) }).placement).toBe("above");
    // above no longer fits (2 rows -> 400px > 288 room above), below does
    expect(computePopupPosition({ ...base, popupSize: popup(400) }).placement).toBe("below");
  });

  it("a menu at a point: pointer near bottom flips above, near right shifts left", () => {
    const r = computePopupPosition({
      anchorRect: pointRect(980, 790),
      popupSize: popup(150, 200),
      viewport: vp,
      gap: 0,
    });
    expect(r.placement).toBe("above");
    expect(r.top).toBe(640);
    expect(r.left).toBe(792);
  });
});

describe("fitsViewport / clampShift", () => {
  it("fitsViewport", () => {
    expect(fitsViewport(anchor(10), vp)).toBe(true);
    expect(fitsViewport(anchor(790, 0, 20), vp)).toBe(false);
  });

  it("never shifts a rect that already fits", () => {
    expect(clampShift({ top: 0, left: 0, right: 1000, bottom: 800 }, vp)).toMatchObject({
      dx: 0,
      dy: 0,
      capHeight: null,
    });
    expect(clampShift(anchor(100), vp)).toMatchObject({ dx: 0, dy: 0 });
  });

  it("shifts back inside with padding when it sticks out", () => {
    const s = clampShift({ top: 700, bottom: 900, left: 900, right: 1100 }, vp);
    expect(s.dy).toBe(792 - 900);
    expect(s.dx).toBe(992 - 1100);
    const neg = clampShift({ top: -50, bottom: 50, left: -20, right: 100 }, vp);
    expect(neg).toMatchObject({ dx: 28, dy: 58 });
  });

  it("caps a rect taller than the viewport", () => {
    const s = clampShift({ top: 100, bottom: 1500, left: 0, right: 100 }, vp);
    expect(s.capHeight).toBe(784);
    // a rect just taller than the padded viewport is capped too
    expect(clampShift({ top: -5, bottom: 790, left: 0, right: 10 }, vp).capHeight).toBe(784);
    expect(clampShift({ top: 0, bottom: 800, left: 0, right: 10 }, vp).capHeight).toBeNull();
    expect(s.dy).toBe(8 - 100);
  });
});
