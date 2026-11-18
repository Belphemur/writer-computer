// Inventory guard (docs/design.md, Scroll ownership): the DOM `scrollIntoView` scrolls every
// scrollable ancestor, `overflow: hidden` frames included, and drags the window frame under the
// tab strip. Panes and pages scroll through `scrollIntoScroller` (`src/lib/scroll-into.ts`), which
// sets one scroller's `scrollTop`. CodeMirror's `scrollIntoView: true` flag and
// `EditorView.scrollIntoView(...)` effect only move the editor's own scroller and are fine.
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { DESKTOP, sourceFiles } from "./helpers/import-graph";

const HELPER = "src/lib/scroll-into.ts";
// A call on an element: `x.scrollIntoView(`, `x?.scrollIntoView?.(`. Not `EditorView.scrollIntoView(`.
const DOM_CALL = /(?<!EditorView)\??\.scrollIntoView\??\.?\(/;

// Different on purpose, each with a reason. Any new entry needs one. Empty: none needed so far.
const ALLOWED = new Set<string>([]);

describe("scroll inventory", () => {
  const files = [...sourceFiles(join(DESKTOP, "src")), ...sourceFiles(join(DESKTOP, "features"))]
    .map((f) => relative(DESKTOP, f))
    .filter((rel) => !rel.includes("/tests/"));

  it("scans the source folders", () => {
    expect(files.length).toBeGreaterThan(300);
  });

  it("no file calls the DOM scrollIntoView outside the allowlist", () => {
    const offenders = files
      .filter((rel) => !ALLOWED.has(rel))
      .filter((rel) => DOM_CALL.test(readFileSync(join(DESKTOP, rel), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("every allowlisted file still exists and still needs its entry", () => {
    const stale = [...ALLOWED].filter((rel) => {
      try {
        return !DOM_CALL.test(readFileSync(join(DESKTOP, rel), "utf8"));
      } catch {
        return true;
      }
    });
    expect(stale).toEqual([]);
  });

  it("the helper exists", () => {
    expect(files).toContain(HELPER);
  });
});
