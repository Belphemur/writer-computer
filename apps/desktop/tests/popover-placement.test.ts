import { describe, expect, it } from "vite-plus/test";
import { computePlacement } from "../src/hooks/use-popover-placement";

const pane = { left: 0, right: 420 };
const anchorAt = (left: number) => ({ left, top: 700, bottom: 730 });

describe("computePlacement", () => {
  it("keeps a popover that fits aligned with its anchor", () => {
    const p = computePlacement(anchorAt(20), pane, 800, { width: 224 });
    expect(p).toMatchObject({ left: 0, width: 224 });
  });

  it("slides left when the popover would cross the pane's right edge", () => {
    // Anchor at x=300, width 320: right edge would be 620 > 412, so it ends at the margin.
    const p = computePlacement(anchorAt(300), pane, 800, { width: 320 });
    expect(300 + p.left + p.width).toBe(412);
    expect(p.width).toBe(320);
  });

  it("shrinks to the pane when it is narrower than the popover", () => {
    const p = computePlacement(anchorAt(10), { left: 0, right: 200 }, 800, { width: 320 });
    expect(p.width).toBe(184);
    expect(10 + p.left).toBe(8);
  });

  it("limits the height to the room above (side top) or below (side bottom)", () => {
    const top = computePlacement({ left: 0, top: 200, bottom: 230 }, pane, 800, {
      width: 200,
      maxHeight: 480,
    });
    expect(top.maxHeight).toBe(184);
    const bottom = computePlacement({ left: 0, top: 10, bottom: 40 }, pane, 300, {
      width: 200,
      side: "bottom",
      maxHeight: 520,
    });
    expect(bottom.maxHeight).toBe(244);
  });

  it("never returns a height below the readable minimum", () => {
    const p = computePlacement({ left: 0, top: 20, bottom: 50 }, pane, 800, { width: 200 });
    expect(p.maxHeight).toBe(120);
  });
});
