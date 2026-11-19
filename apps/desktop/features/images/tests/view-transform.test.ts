// The viewer's pure view model: fit (up and down), zoom about a point, clamps, pan bounds and the
// Fit / 100% toggle.
import { describe, expect, it } from "vite-plus/test";
import {
  FIT_MARGIN,
  ZOOM_MAX,
  ZOOM_MIN,
  canPan,
  clampScale,
  fitScale,
  panBy,
  percent,
  resolveView,
  toggleActualSize,
  wheelFactor,
  zoomBy,
  zoomTo,
  type Size,
  type Transform,
} from "../web/lib/view-transform";

const page: Size = { width: 800, height: 600 };
const inner = { width: page.width - 2 * FIT_MARGIN, height: page.height - 2 * FIT_MARGIN };

describe("fit", () => {
  it("scales a small image up to fill the page", () => {
    const svg = { width: 103, height: 150 };
    expect(fitScale(svg, page)).toBeCloseTo(inner.height / 150, 6);
    expect(fitScale(svg, page)).toBeGreaterThan(3);
    const t = resolveView(null, svg, page);
    expect(svg.height * t.scale).toBeCloseTo(inner.height, 6);
    // centred on the other axis
    expect(t.x).toBeCloseTo((page.width - svg.width * t.scale) / 2, 6);
    expect(t.y).toBeCloseTo(FIT_MARGIN, 6);
  });

  it("scales a large image down, by the tighter axis", () => {
    const png = { width: 4000, height: 1000 };
    expect(fitScale(png, page)).toBeCloseTo(inner.width / 4000, 6);
    expect(fitScale({ width: 1000, height: 4000 }, page)).toBeCloseTo(inner.height / 4000, 6);
  });

  it("survives a page with no room and an image with no size", () => {
    expect(fitScale({ width: 100, height: 100 }, { width: 10, height: 10 })).toBeGreaterThan(0);
    expect(fitScale({ width: 0, height: 0 }, page)).toBe(1);
  });
});

describe("clamps", () => {
  it("keeps 5%..3200%", () => {
    expect(clampScale(100, 1)).toBe(ZOOM_MAX);
    expect(clampScale(0.001, 1)).toBe(ZOOM_MIN);
    expect(clampScale(Number.NaN, 2)).toBe(2);
  });

  it("lets an enormous image go down to its Fit", () => {
    expect(clampScale(0.001, 0.01)).toBe(0.01);
  });

  it("zoom steps stop at the bounds", () => {
    const c = { width: 100, height: 100 };
    const origin = { x: 400, y: 300 };
    let view = zoomTo(null, 1, origin, c, page);
    for (let i = 0; i < 60; i++) view = zoomBy(view, 1.25, origin, c, page);
    expect(resolveView(view, c, page).scale).toBe(ZOOM_MAX);
    for (let i = 0; i < 80; i++) view = zoomBy(view, 0.8, origin, c, page);
    expect(resolveView(view, c, page).scale).toBe(ZOOM_MIN);
  });
});

describe("zoom about a point", () => {
  const c = { width: 1000, height: 800 };

  it("keeps the image point under the pointer fixed", () => {
    const start: Transform = { scale: 1, x: -200, y: -100 };
    const anchor = { x: 300, y: 250 };
    const imagePoint = { x: (anchor.x - start.x) / 1, y: (anchor.y - start.y) / 1 };
    const next = resolveView(zoomTo(start, 2, anchor, c, page), c, page);
    expect(next.scale).toBe(2);
    expect((anchor.x - next.x) / next.scale).toBeCloseTo(imagePoint.x, 6);
    expect((anchor.y - next.y) / next.scale).toBeCloseTo(imagePoint.y, 6);
  });

  it("zooming out to Fit snaps back to Fit (null), so a resize follows", () => {
    const fit = fitScale(c, page);
    const free = zoomTo(null, fit * 2, { x: 400, y: 300 }, c, page);
    expect(free).not.toBeNull();
    expect(zoomTo(free, fit, { x: 400, y: 300 }, c, page)).toBeNull();
  });

  it("zoomBy multiplies the current scale", () => {
    const next = resolveView(zoomBy(null, 1.25, { x: 400, y: 300 }, c, page), c, page);
    expect(next.scale).toBeCloseTo(fitScale(c, page) * 1.25, 6);
  });

  it("a wheel notch zooms in for deltaY < 0 and out for > 0", () => {
    expect(wheelFactor(-10)).toBeGreaterThan(1);
    expect(wheelFactor(10)).toBeLessThan(1);
    expect(wheelFactor(-5000)).toBe(wheelFactor(-50)); // one notch cannot jump
  });
});

describe("pan bounds", () => {
  const c = { width: 1000, height: 800 };

  it("does nothing while the image fits", () => {
    expect(panBy(null, 50, 50, c, page)).toBeNull();
    const small = { scale: 0.5, x: 150, y: 100 };
    expect(canPan(small, c, page)).toBe(false);
  });

  it("an image larger than the page cannot leave it: the edges stop at the page", () => {
    const big: Transform = { scale: 2, x: 0, y: 0 }; // 2000 x 1600
    const left = resolveView(panBy(big, 500, 500, c, page), c, page);
    expect(left.x).toBe(0);
    expect(left.y).toBe(0);
    const right = resolveView(panBy(big, -5000, -5000, c, page), c, page);
    expect(right.x).toBe(page.width - 2000);
    expect(right.y).toBe(page.height - 1600);
  });

  it("an axis that fits stays centred while the other pans", () => {
    const tall = { width: 100, height: 4000 };
    const t = resolveView(panBy({ scale: 1, x: 0, y: 0 }, 30, -200, tall, page), tall, page);
    expect(t.x).toBe((page.width - 100) / 2);
    expect(t.y).toBe(-200);
  });
});

describe("Fit and 100%", () => {
  const c = { width: 103, height: 150 };
  const anchor = { x: 200, y: 200 };

  it("a double-click goes from Fit to 100% about the pointer, and back", () => {
    const actual = toggleActualSize(null, anchor, c, page);
    expect(actual).not.toBeNull();
    expect(resolveView(actual, c, page).scale).toBe(1);
    expect(toggleActualSize(actual, anchor, c, page)).toBeNull();
  });

  it("from any other zoom it goes to 100%", () => {
    const view = zoomTo(null, 8, anchor, c, page);
    expect(resolveView(toggleActualSize(view, anchor, c, page), c, page).scale).toBe(1);
  });

  it("formats a percent", () => {
    expect(percent(1)).toBe(100);
    expect(percent(0.0504)).toBe(5);
    expect(percent(32)).toBe(3200);
  });
});
