// Feature web code reaches its Rust commands through the generated bindings, never by a raw
// `invoke`: a hand-written args object is how `chat_id` (the name Tauri does not read) got past
// review. The route and the argument names of every command are pinned against the bindings by
// `describeFeatureIpc` (`tests/helpers/feature-ipc.ts`); this guard keeps that the only way in.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { DESKTOP } from "./helpers/import-graph";

const FEATURES = join(DESKTOP, "features");
const features = readdirSync(FEATURES).filter((d: string) =>
  existsSync(join(FEATURES, d, "feature.json")),
);
const manifest = (id: string) =>
  JSON.parse(readFileSync(join(FEATURES, id, "feature.json"), "utf8")) as {
    rust?: { commands?: string[] };
  };
const withCommands = features.filter(
  (id: string) => (manifest(id).rust?.commands ?? []).length > 0,
);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name: string) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

/** The one hand-typed args map left: the agent's object-argument client (`callAgent`, 42 commands,
 *  every call site passes an object), pinned key by key against the bindings by `agent-ipc.test.ts`. */
const FEATURE_INVOKE = new Set(["features/agent/web/ipc.ts"]);

describe("feature IPC", () => {
  for (const id of withCommands) {
    it(`${id} has a test driving every wrapper (describeFeatureIpc)`, () => {
      const dir = join(FEATURES, id, "tests");
      const tests: string[] = readdirSync(dir).filter((f: string) => f.endsWith("-ipc.test.ts"));
      expect(tests, id).not.toEqual([]);
      const uses = tests.some((f) =>
        readFileSync(join(dir, f), "utf8").includes("describeFeatureIpc("),
      );
      expect(uses, id).toBe(true);
    });
  }

  it("no feature web code calls a feature command by a raw invoke or a hand-typed route", () => {
    const own = new Set(withCommands.flatMap((id: string) => manifest(id).rust?.commands ?? []));
    const offenders: string[] = [];
    for (const id of features) {
      const web = join(FEATURES, id, "web");
      if (!existsSync(web)) continue;
      for (const file of sources(web)) {
        const rel = relative(DESKTOP, file);
        if (rel.endsWith("web/bindings.ts")) continue;
        const text = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
        if (/plugin:[a-z-]+\|/.test(text)) offenders.push(`${rel}: a hand-typed plugin route`);
        if (/\bfeatureInvoke\b/.test(text) && !FEATURE_INVOKE.has(rel)) {
          offenders.push(`${rel}: featureInvoke`);
        }
        for (const m of text.matchAll(/\binvoke(?:<[^>(]*>)?\(\s*["'`]([\w:|-]+)/g)) {
          if (own.has(m[1]!) || m[1]!.includes("|")) offenders.push(`${rel}: invoke("${m[1]}")`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
