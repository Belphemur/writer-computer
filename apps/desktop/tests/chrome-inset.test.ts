import { describe, expect, test } from "vite-plus/test";
import schema from "@shared/settings.schema.json";
import {
  chromeInset,
  drawsWindowControls,
  installPlatformAttribute,
  MENU_BUTTON,
  WINDOW_CONTROLS,
} from "../src/lib/platform";

describe("chromeInset", () => {
  test("macOS reserves the traffic-light gap at the left and nothing at the right", () => {
    expect(chromeInset("macos")).toEqual({ start: 92, end: 0 });
    expect(chromeInset("macos", true)).toEqual({ start: 92, end: 0 });
  });

  test("Linux reserves the menu button at the left and the window controls at the right", () => {
    expect(chromeInset("linux")).toEqual({ start: 52, end: 116 });
  });

  test("the reserved space is the sum of the sizes the components draw with", () => {
    const { start, end } = chromeInset("linux");
    expect(start).toBe(MENU_BUTTON.edge + MENU_BUTTON.width + MENU_BUTTON.gap);
    expect(end).toBe(WINDOW_CONTROLS.count * WINDOW_CONTROLS.buttonWidth + WINDOW_CONTROLS.edge);
  });

  test("Linux with the desktop's frame keeps the menu button and drops the controls", () => {
    expect(chromeInset("linux", true)).toEqual({ start: 52, end: 0 });
  });

  test("another platform reserves nothing", () => {
    expect(chromeInset("windows")).toEqual({ start: 0, end: 0 });
  });
});

describe("drawsWindowControls", () => {
  test("only Linux without native decorations", () => {
    expect(drawsWindowControls("linux", false)).toBe(true);
    expect(drawsWindowControls("linux", true)).toBe(false);
    expect(drawsWindowControls("macos", false)).toBe(false);
    expect(drawsWindowControls("windows", false)).toBe(false);
  });
});

describe("installPlatformAttribute", () => {
  test("marks the root element", () => {
    // The suite runs in node: give the helper a document to write to.
    const attrs = new Map<string, string>();
    const doc = { documentElement: { setAttribute: (k: string, v: string) => attrs.set(k, v) } };
    (globalThis as { document?: unknown }).document = doc;
    try {
      installPlatformAttribute("linux");
      expect(attrs.get("data-platform")).toBe("linux");
    } finally {
      delete (globalThis as { document?: unknown }).document;
    }
  });
});

describe("appearance.native-decorations", () => {
  const def = schema.settings.find((s) => s.key === "appearance.native-decorations");

  test("is a Linux-only boolean, global, off by default, with a label", () => {
    expect(def).toBeDefined();
    expect(def).toMatchObject({
      type: "boolean",
      default: false,
      platform: "linux",
      scope: "global",
      category: "Appearance",
    });
    expect(def!.label.length).toBeGreaterThan(0);
    expect(def!.description.length).toBeGreaterThan(0);
  });
});
