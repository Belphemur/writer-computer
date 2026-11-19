// The fonts ship in the bundle, so a drawing never goes to the network.
import { describe, expect, it } from "vite-plus/test";
import { ASSET_URL_PREFIX, excalidrawFontFiles } from "../vite-assets";

describe("bundled fonts", () => {
  const files = excalidrawFontFiles();
  it("includes the hand-drawn and code faces as woff2", () => {
    expect(files.some((f) => f.startsWith("fonts/Excalifont/"))).toBe(true);
    expect(files.some((f) => f.startsWith("fonts/Virgil/"))).toBe(true);
    expect(files.every((f) => f.endsWith(".woff2"))).toBe(true);
  });
  it("leaves out the 12 MB CJK font", () => {
    expect(files.some((f) => f.includes("Xiaolai"))).toBe(false);
  });
  it("is served where the lib points EXCALIDRAW_ASSET_PATH", () => {
    expect(ASSET_URL_PREFIX).toBe("/excalidraw-assets/");
  });
});
