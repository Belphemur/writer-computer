// Inventory guard: the modal keyboard model (Escape, the Tab focus trap, initial focus, focus
// restore) and the `aria-modal` backdrop/card live in `src/components/modal-shell.tsx` only. A React
// modal renders `<ModalShell>`; a hand-written `"Tab"` trap or `aria-modal` elsewhere is a second
// copy that drifts.
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { DESKTOP, sourceFiles } from "./helpers/import-graph";

const SHELL = "src/components/modal-shell.tsx";
const FORBIDDEN = /aria-modal|["']aria-modal["']|key\s*[!=]==?\s*["']Tab["']/;

// Different on purpose, each with a reason. Any new entry needs one.
const ALLOWED = new Set([
  SHELL,
  // Imperative CodeMirror widgets, not React: a fullscreen overlay built with `createElement`.
  "src/components/editor-area/mermaid-fullscreen.ts",
  "features/tables/web/table-fullscreen.ts",
  // Palettes, pickers and popovers own a keyboard model of their own (roving selection, Tab
  // accepts or moves through options); they are not modals and do not trap focus in a card.
  "src/components/editor-area/property-wikilink.tsx",
  "src/components/editor-area/property-type-control.tsx",
  "src/components/editor-area/enum-select.tsx",
  "features/agent/web/components/row-menu.tsx",
  "features/agent/web/components/composer.tsx",
  "features/bases/web/view/expression-input.tsx",
]);

describe("modal inventory", () => {
  const files = [...sourceFiles(join(DESKTOP, "src")), ...sourceFiles(join(DESKTOP, "features"))];

  it("scans the source folders", () => {
    expect(files.length).toBeGreaterThan(300);
  });

  it("no file hand-writes a modal focus trap or aria-modal outside the shell", () => {
    const offenders = files
      .map((f) => relative(DESKTOP, f))
      .filter((rel) => !rel.includes("/tests/") && !ALLOWED.has(rel))
      .filter((rel) => FORBIDDEN.test(readFileSync(join(DESKTOP, rel), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("every allowlisted file still exists and still needs its entry", () => {
    const stale = [...ALLOWED].filter((rel) => {
      try {
        return !FORBIDDEN.test(readFileSync(join(DESKTOP, rel), "utf8"));
      } catch {
        return true;
      }
    });
    expect(stale).toEqual([]);
  });
});
