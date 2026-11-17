// Inventory guard (SPECs/link-activation-spec.md section 4): the middle button and `auxclick`
// for a link live in `src/lib/link-activation.ts` only. Tabs are not links: they close on a
// middle click and keep their own handler.
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { DESKTOP, sourceFiles } from "./helpers/import-graph";

const ALLOWED = new Set([
  "src/lib/link-activation.ts",
  "src/components/editor-area/editor-tabs.tsx",
  "features/agent/web/components/chat-tabs.tsx",
]);
const FORBIDDEN = /button\s*[!=]==?\s*1\b|onAuxClick|["']auxclick["']/;

// Direct tab-opening calls: only the store, its API wrapper, the module, and the two adapters that
// take an intent from the module (Bases cells, the Obsidian host's workspace) may make them. A click
// handler opens a note through `openPath` / `activateLink` / the bindings instead.
const OPEN_ALLOWED = new Set([
  "src/lib/link-activation.ts",
  "src/hooks/editor-api.ts",
  "src/stores/editor-store.ts",
  "features/obsidian-host/web/stores/plugins-store.ts",
]);
const DIRECT_OPEN = /\b(openFileInNewTab|navigateToFile)\(/;

// The system browser opens through `openExternal` only; the allowed schemes are
// `EXTERNAL_PROTOCOLS` (`src/lib/external-url.ts`) only. The Obsidian plugin host's own
// sanitiser allowlists (they also admit `tel:` and data images, a different rule: what may be
// rendered, not what may be opened) are the exceptions.
const OPEN_URL = /import\s*\{[^}]*\bopenUrl\b[^}]*\}\s*from\s*["']@tauri-apps\/plugin-opener["']/;
const URL_OPENER_ALLOWED = new Set(["src/lib/link-activation.ts"]);
// A scheme list in code: a quoted `mailto:` or `mailto` in a regex alternation.
const SCHEME_LIST = /["']mailto:?["']|\|mailto\b|\bmailto\|/i;
const SCHEME_ALLOWED = new Set([
  "src/lib/external-url.ts",
  // `mailto:` is exempt from the same-origin rule there: a use of one scheme, not a list.
  "features/obsidian-host/web/host/node/external-links.ts",
  "features/obsidian-host/web/plugin-browser/link-action.ts",
  "features/obsidian-host/web/plugin-browser/render-readme.ts",
  "features/obsidian-host/web/host/api/markdown-render.ts",
]);

// The `[[...]]` grammar lives in `src/lib/wiki-links.ts` (`isWikiLink`, `wikiLinkInner`,
// `parseWikiLink`, `wikiLinkScanner`, `matchWikiLinkAtStart`, `WIKI_SUGGEST_TRIGGER`). A regex that
// spells the brackets elsewhere is a re-parse. Kept on purpose: the table cell's Lezer inline
// parser (it scans characters, escapes included) writes none; the Obsidian host's `[[` mentions
// are in comments or strings. Any new entry here needs a reason.
const BRACKET_REGEX = /\\\[\\\[|startsWith\(["']\[\[["']\)|endsWith\(["']\]\]["']\)/;
const BRACKET_ALLOWED = new Set(["src/lib/wiki-links.ts"]);

describe("link activation inventory", () => {
  const files = [...sourceFiles(join(DESKTOP, "src")), ...sourceFiles(join(DESKTOP, "features"))];

  it("scans the source folders", () => {
    expect(files.length).toBeGreaterThan(300);
  });

  it("no file hand-writes middle-button or auxclick handling for a link", () => {
    const offenders = files
      .map((f) => relative(DESKTOP, f))
      .filter((f) => !ALLOWED.has(f) && !f.includes("/tests/"))
      .filter((f) => FORBIDDEN.test(readFileSync(join(DESKTOP, f), "utf8")));
    expect(offenders, "use linkHandlers, bindLinkActivation or linkActivationExtension").toEqual(
      [],
    );
  });

  it("no file opens a note in a tab directly from a click handler: use openPath or the bindings", () => {
    const offenders = files
      .map((f) => relative(DESKTOP, f))
      .filter((f) => !OPEN_ALLOWED.has(f) && !f.includes("/tests/"))
      .filter((f) => DIRECT_OPEN.test(readFileSync(join(DESKTOP, f), "utf8")));
    expect(offenders).toEqual([]);
  });

  const offending = (re: RegExp, allowed: Set<string>) =>
    files
      .map((f) => relative(DESKTOP, f))
      .filter((f) => !allowed.has(f) && !f.includes("/tests/"))
      .filter((f) => re.test(readFileSync(join(DESKTOP, f), "utf8")));

  it("no file opens a URL itself: use openExternal", () => {
    expect(offending(OPEN_URL, URL_OPENER_ALLOWED)).toEqual([]);
  });

  it("no file spells the external scheme list: use EXTERNAL_PROTOCOLS", () => {
    expect(offending(SCHEME_LIST, SCHEME_ALLOWED)).toEqual([]);
  });

  it("no file re-parses the [[ ]] brackets: use lib/wiki-links.ts", () => {
    expect(offending(BRACKET_REGEX, BRACKET_ALLOWED)).toEqual([]);
  });
});
