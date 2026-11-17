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
  "src/components/agent/chat-tabs.tsx",
]);
const FORBIDDEN = /button\s*[!=]==?\s*1\b|onAuxClick|["']auxclick["']/;

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
});
