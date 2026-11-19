// @vitest-environment jsdom
// The page body contract: the window chrome floats over the top of the editor area, every page
// kind mounts in `PageBody` (below the chrome, positioned, clipped), and no view reserves the
// chrome's height itself or escapes the body with `position: fixed` / a portal except the
// allowlisted overlays below.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { DESKTOP } from "./helpers/import-graph";
import { PageBody } from "@/components/editor-area/page-body";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("PageBody", () => {
  it("is the positioned, clipped ancestor that starts below the chrome bar", () => {
    const el = document.createElement("div");
    const root = createRoot(el);
    act(() => root.render(<PageBody>x</PageBody>));
    const body = el.querySelector<HTMLElement>("[data-testid=page-body]")!;
    expect(body.className).toMatch(/\babsolute\b/);
    expect(body.className).toMatch(/\boverflow-clip\b/);
    expect(body.className).toMatch(/\bbottom-0\b/);
    expect(body.style.top).toBe("var(--chrome-bar-height)");
    act(() => root.unmount());
  });
});

const sources = import.meta.glob<string>(
  [
    "../src/components/{editor-area,image-viewer,settings-panel}/**/*.{ts,tsx}",
    "../src/components/{feature-off-page,feature-pane}.tsx",
    "../features/{graph,bases,code-files}/web/**/*.{ts,tsx}",
    "../features/obsidian-host/web/components/**/*.{ts,tsx}",
  ],
  { query: "?raw", import: "default", eager: true },
);

/** Files that draw outside the page body on purpose, with the reason. */
const OVERLAYS: Record<string, string> = {
  "src/components/editor-area/anchored-popover.tsx": "popover under its anchor, portalled to body",
  "src/components/editor-area/editor-notice-banner.tsx":
    "the app notice (toast), bottom of the window above every layer",
  "features/bases/web/view/expression-input.tsx": "autocomplete popover",
  "features/bases/web/view/view-switcher.tsx": "view menu popover",
};
const ESCAPES = /createPortal\(|position:\s*["']?fixed|\bclassName=.*\bfixed\b/;
const escapes = (src: string) => src.split("\n").some((l) => ESCAPES.test(l));
const RELATIVE_PATH = (p: string) => p.replace(/^\.\.\//, "");

describe("page kind bodies stay inside the page body", () => {
  const entries = Object.entries(sources).map(([p, src]) => [RELATIVE_PATH(p), src] as const);

  it("scans the page kind sources", () => {
    expect(entries.length).toBeGreaterThan(50);
  });

  it("none escapes with fixed positioning or a portal unless allowlisted", () => {
    const offenders = entries
      .filter(([p]) => !p.endsWith(".md") && !(p in OVERLAYS))
      .filter(([, src]) => escapes(src))
      .map(([p]) => p);
    expect(offenders).toEqual([]);
  });

  it("every allowlisted overlay still escapes (drop stale entries)", () => {
    for (const p of Object.keys(OVERLAYS)) {
      const src = entries.find(([q]) => q === p)?.[1];
      expect(src, p).toBeDefined();
      expect(escapes(src!), p).toBe(true);
    }
  });

  it("no tab body reserves the chrome's height with its own top padding", () => {
    const bodies = entries.filter(
      ([p]) =>
        /plugin-(file|view)-tab\.tsx$/.test(p) ||
        p === "features/bases/web/view/index.tsx" ||
        p === "features/graph/web/graph-view.tsx",
    );
    expect(bodies.length).toBe(4);
    for (const [p, src] of bodies) expect(src, p).not.toMatch(/\bpt-(10|12|14|16)\b/);
  });
});

// The window frame never scrolls, not even by script: `overflow: hidden` still lets
// `scrollIntoView`/`scrollTop` shift the box and drag the page over the tab strip, `clip` does not.
// docs/design.md, Scroll ownership.
describe("frame containers are overflow: clip", () => {
  const read = (rel: string) => readFileSync(join(DESKTOP, rel), "utf8");
  const FRAME_FILES = [
    "src/components/app-layout.tsx",
    "src/components/editor-area/index.tsx",
    "src/components/editor-area/page-body.tsx",
    "src/components/sidebar/index.tsx",
  ];

  it("no frame file uses overflow-hidden, and each uses overflow-clip", () => {
    for (const rel of FRAME_FILES) {
      const src = read(rel);
      expect(src, rel).not.toMatch(/\boverflow-(x-|y-)?hidden\b/);
      expect(src, rel).toMatch(/\boverflow-clip\b/);
    }
  });

  it("the compact layout's window root clips (its leaf ellipsis spans may stay hidden)", () => {
    expect(read("src/components/compact-file-layout.tsx")).toMatch(
      /h-screen w-screen overflow-clip/,
    );
  });

  it("the document root, body and #root clip", () => {
    const css = read("src/App.css");
    const rule = /^html,\s*body,\s*#root\s*\{([^}]*)\}/m.exec(css)?.[1] ?? "";
    expect(rule).toMatch(/overflow:\s*clip\s*;/);
  });
});
