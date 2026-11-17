import { describe, expect, it } from "vite-plus/test";
import { scrollDeltaIntoView } from "../src/hooks/use-scroll-active-tab-into-view";

const view = { left: 100, right: 400 };

describe("scrollDeltaIntoView", () => {
  it("is 0 for a tab fully inside the view", () => {
    expect(scrollDeltaIntoView({ left: 120, right: 300 }, view)).toBe(0);
  });
  it("scrolls left by the hidden amount at the start edge", () => {
    expect(scrollDeltaIntoView({ left: 60, right: 200 }, view)).toBe(-40);
  });
  it("scrolls right by the hidden amount at the end edge", () => {
    expect(scrollDeltaIntoView({ left: 350, right: 450 }, view)).toBe(50);
  });
  it("aligns the start of a tab wider than the view", () => {
    expect(scrollDeltaIntoView({ left: 150, right: 600 }, view)).toBe(50);
  });
});
