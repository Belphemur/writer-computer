// The app turns text selection off everywhere (`src/App.css`) except an explicit list; an area
// whose text the user reads and copies opts in with `data-selectable` (docs/design.md
// "Text selection"). jsdom applies no stylesheet, so this pins the CSS and the markers.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { DESKTOP } from "./helpers/import-graph";

const read = (rel: string) => readFileSync(join(DESKTOP, rel), "utf8");
const css = read("src/App.css");

describe("text selection contract", () => {
  it("data-selectable is excluded from the no-select rule and turned back on", () => {
    const noSelect = css.slice(css.indexOf("*:not(.cm-editor)"), css.indexOf("user-select: none;"));
    expect(noSelect).toContain("[data-selectable] *");
    expect(css).toMatch(
      /\[data-selectable\],\s*\[data-selectable\] \*,[^{]*\{\s*-webkit-user-select: text;/,
    );
  });

  it("controls inside a selectable area stay non-selectable", () => {
    expect(css).toMatch(/\[data-selectable\] :is\(button, \[role="button"\]/);
  });

  it.each([
    ["the agent pane", "features/agent/web/components/agent-pane.tsx"],
    ["the session changes tab", "features/agent/web/components/session-changes-tab.tsx"],
  ])("%s opts in", (_, file) => {
    expect(read(file)).toMatch(/\bdata-selectable\b/);
  });
});
