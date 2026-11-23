// Feature web code reaches its Rust commands through the generated bindings, from `web/ipc.ts`
// only: a hand-written args object is how `chat_id` (the name Tauri does not read) got past review.
// The route, the argument names and the values of every command are pinned against the bindings by
// `describeFeatureIpc` (`tests/helpers/feature-ipc.ts`); this guard keeps `ipc.ts` the only way in
// (the features ADR's "fail when a feature imports the generated runtime outside ipc.ts").
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { DESKTOP, importsOfText, sourceFiles } from "./helpers/import-graph";

const FEATURES = join(DESKTOP, "features");
const features: string[] = readdirSync(FEATURES).filter((d: string) =>
  existsSync(join(FEATURES, d, "feature.json")),
);
const manifest = (id: string) =>
  JSON.parse(readFileSync(join(FEATURES, id, "feature.json"), "utf8")) as {
    rust?: { commands?: string[] };
  };
const withCommands: string[] = features.filter(
  (id: string) => (manifest(id).rust?.commands ?? []).length > 0,
);
const ownCommands = new Set(
  withCommands.flatMap((id: string) => manifest(id).rust?.commands ?? []),
);

/** The one `ipc.ts` that keeps a hand-typed args map: the agent's object-argument client
 *  (`callAgent`, every call site passes an object), pinned key by key by `agent-ipc.test.ts`. */
const FEATURE_INVOKE = new Set(["features/agent/web/ipc.ts"]);

/** The source without comments, strings kept (`//` inside a URL is not a comment). */
function stripComments(src: string): string {
  let out = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === '"' || c === "'" || c === "`") {
      const start = i;
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === "\\") i++;
      out += src.slice(start, i + 1);
    } else if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 1;
    } else out += c;
  }
  return out;
}

/** What is wrong in one feature web file (`rel`: its path under `apps/desktop`). */
function problems(rel: string, src: string): string[] {
  const out: string[] = [];
  const code = stripComments(src);
  const isIpc = rel.endsWith("/web/ipc.ts");
  for (const i of importsOfText(code)) {
    if (!isIpc && !i.typeOnly && /(^|\/)bindings$/.test(i.spec)) out.push("imports the bindings");
    if (i.spec === "@/lib/features/ipc" && !FEATURE_INVOKE.has(rel)) out.push("uses featureInvoke");
    if (i.spec === "@tauri-apps/api/core" && !isIpc) {
      const named = new RegExp(`import\\s*(?:type\\s*)?\\{[^}]*\\binvoke\\b[^}]*\\}\\s*from`).test(
        code,
      );
      if (named || /import\s*\*\s*as\s+\w+\s*from\s*["']@tauri-apps\/api\/core/.test(code)) {
        out.push("imports invoke");
      }
    }
  }
  if (/plugin:(\$\{|["'`]\s*\+|[a-z-]+\|)/.test(code)) out.push("builds a plugin route by hand");
  for (const m of code.matchAll(/\binvoke(?:<(?:[^<>()]|<[^<>]*>)*>)?\(\s*["'`]([\w:|-]+)/g)) {
    if (ownCommands.has(m[1]!)) out.push(`invokes the feature command ${m[1]} by hand`);
  }
  return out;
}

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

  it("only web/ipc.ts of a feature with commands reaches them (bindings, invoke, routes)", () => {
    const offenders: string[] = [];
    for (const id of withCommands) {
      for (const file of sourceFiles(join(FEATURES, id, "web"))) {
        const rel = relative(DESKTOP, file);
        if (rel.endsWith("web/bindings.ts")) continue;
        for (const p of problems(rel, readFileSync(file, "utf8"))) offenders.push(`${rel}: ${p}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("catches the forms that dodge a text search", () => {
    const web = "features/git/web";
    const cases: [string, string, string][] = [
      ["template route", `${web}/ipc.ts`, "invoke(`plugin:${id}|x`)"],
      ["concatenated route", `${web}/ipc.ts`, 'invoke("plugin:" + id + "|x")'],
      [
        "a component importing the bindings",
        `${web}/components/a.tsx`,
        'import { commands } from "../bindings";',
      ],
      [
        "the bindings by alias",
        `${web}/lib/a.ts`,
        'import { commands } from "@features/git/web/bindings";',
      ],
      [
        "a component importing invoke",
        `${web}/components/a.tsx`,
        'import { invoke } from "@tauri-apps/api/core";',
      ],
      [
        "a component using featureInvoke",
        `${web}/lib/a.ts`,
        'import { featureInvoke } from "@/lib/features/ipc";',
      ],
      [
        "a feature command by hand",
        `${web}/ipc.ts`,
        'invoke<Record<string, number>>("git_status", {})',
      ],
    ];
    for (const [name, rel, src] of cases) expect(problems(rel, src), name).not.toEqual([]);
    // Comments and a `//` inside a URL string are not code.
    expect(
      problems(`${web}/ipc.ts`, '// plugin:git|x\nconst u = "https://x/y"; /* plugin:git|y */'),
    ).toEqual([]);
    expect(problems(`${web}/ipc.ts`, 'const a = "http://x"; invoke(`plugin:${id}|x`)')).not.toEqual(
      [],
    );
    expect(problems(`${web}/components/a.tsx`, 'import type { X } from "../bindings";')).toEqual(
      [],
    );
  });
});
