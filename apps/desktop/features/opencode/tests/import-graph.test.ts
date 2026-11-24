/**
 * The web half of the agent never names OpenCode (spec `SPECs/opencode-backend-spec.md` section 5
 * and section 11, phase 2): `features/agent/web/` and the shared agent tables stay backend-neutral;
 * the OpenCode feature reaches them through the registration points. Comments may explain a seam by
 * naming the backend it was made for, code may not. The Rust twin is `import_graph_tests.rs`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

const AGENT_WEB = fileURLToPath(new URL("../../agent/web", import.meta.url));
/** Where the neutral code may name a backend: nowhere. The picker, the Settings tab and the chip
 *  read the `agent.backends` registry, so a backend's name never appears in their code. */
const ALLOWED = new Set<string>();

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.(ts|tsx)$/.test(name) && name !== "bindings.ts") out.push(path);
  }
  return out;
}

/** The backend's name, except inside the `intoOpenCode` of the code-block helper (a different word). */
const NAMES_BACKEND = /(?<!into)opencode/i;

/** Code without comments: block comments, then everything after a `//` that is not in a URL. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");
}

describe("agent import graph", () => {
  it("the neutral web code names no backend", () => {
    const files = sources(AGENT_WEB);
    expect(files.length).toBeGreaterThan(30);
    const leaks = files
      .filter((f) => !ALLOWED.has(f.slice(AGENT_WEB.length + 1)))
      .filter((f) => NAMES_BACKEND.test(code(readFileSync(f, "utf8"))))
      .map((f) => f.slice(AGENT_WEB.length + 1));
    expect(leaks).toEqual([]);
  });

  it("the scan sees a leak and skips comments and URLs", () => {
    expect(NAMES_BACKEND.test(code("import x from '@features/opencode/web';"))).toBe(true);
    expect(NAMES_BACKEND.test(code("// opencode\n/* opencode */ const a = 1;"))).toBe(false);
    expect(NAMES_BACKEND.test("function intoOpenCode() {}")).toBe(false);
  });
});
