// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { logger } from "@/lib/logger";
import { addIcon, getIcon, getIconIds, removeIcon, setIcon } from "../web/host/api/functions";
import { BUILTIN_ICON_IDS } from "../web/host/api/icons";

afterEach(() => vi.restoreAllMocks());

describe("setIcon / getIcon", () => {
  it("draws a known Lucide id as a sized, stroked svg", () => {
    const el = document.createElement("div");
    setIcon(el, "file-text");
    const svg = el.querySelector("svg")!;
    expect(svg.classList.contains("svg-icon")).toBe(true);
    expect(svg.classList.contains("lucide-file-text")).toBe(true);
    expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(svg.querySelectorAll("path").length).toBeGreaterThan(0);
    // attributes are real SVG attributes (kebab-case), not React props
    expect(svg.querySelector("[stroke-linecap]")).not.toBeNull();
    expect(svg.innerHTML).not.toContain("strokeLinecap");
  });

  it("accepts the lucide- prefix and replaces earlier content", () => {
    const el = document.createElement("div");
    el.textContent = "old";
    setIcon(el, "lucide-search");
    expect(el.textContent).toBe("");
    expect(el.querySelectorAll("svg")).toHaveLength(1);
  });

  it("draws the Obsidian-only ids the LanguageTool plugin asks for", () => {
    for (const id of ["checkbox-glyph", "file-text", "reset", "uppercase-lowercase-a"]) {
      expect(getIcon(id)?.querySelector("path, circle, rect, line")).not.toBeNull();
    }
  });

  it("an unknown id draws nothing and logs once", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const el = document.createElement("div");
    setIcon(el, "no-such-icon-xyz");
    setIcon(el, "no-such-icon-xyz");
    expect(el.children).toHaveLength(0);
    expect(el.textContent).toBe("");
    expect(getIcon("no-such-icon-xyz")).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[1])).toContain("no-such-icon-xyz");
  });

  it("a registered icon wins over the table and is listed", () => {
    addIcon("file-text", '<path d="M0 0h10v10z"/>');
    expect(getIcon("file-text")?.getAttribute("viewBox")).toBe("0 0 100 100");
    expect(getIconIds()).toContain("file-text");
    removeIcon("file-text");
    expect(getIcon("file-text")?.getAttribute("viewBox")).toBe("0 0 24 24");
  });

  it("every id in the table renders", () => {
    expect(BUILTIN_ICON_IDS.length).toBeGreaterThan(80);
    for (const id of BUILTIN_ICON_IDS) expect(getIcon(id), id).not.toBeNull();
  });
});
