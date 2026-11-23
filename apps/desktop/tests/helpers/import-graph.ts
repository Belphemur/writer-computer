// Reads import specifiers out of source files and follows them (static imports only, or all),
// with the app's aliases (`@/`, `@features/`, `@shared/`, `@tests/`). Shared by the import-boundary
// guard and the features' "not in the startup chunk" tests.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export const DESKTOP = resolve(import.meta.dirname, "../..");

const ALIASES: [string, string][] = [
  ["@/", join(DESKTOP, "src") + "/"],
  ["@features/", join(DESKTOP, "features") + "/"],
  ["@shared/", join(DESKTOP, "shared") + "/"],
  ["@tests/", join(DESKTOP, "tests") + "/"],
];

export interface Import {
  spec: string;
  /** `import(...)`: not part of the startup graph. */
  dynamic: boolean;
  /** `import type` / `export type`: erased at build time. */
  typeOnly: boolean;
}

const STATIC =
  /^\s*(import|export)(\s+type)?\s[^"'()]*?from\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']/gm;
const DYNAMIC = /\b(?:import|vi\.mock|vi\.importActual)\(\s*["']([^"']+)["']/g;

export function importsOf(file: string): Import[] {
  return importsOfText(readFileSync(file, "utf8"));
}

/** The same for source text (a fixture needs no file). */
export function importsOfText(src: string): Import[] {
  const out: Import[] = [];
  for (const m of src.matchAll(STATIC)) {
    out.push({ spec: (m[3] ?? m[4])!, dynamic: false, typeOnly: m[2] !== undefined });
  }
  for (const m of src.matchAll(DYNAMIC)) out.push({ spec: m[1]!, dynamic: true, typeOnly: false });
  return out;
}

/** The file a specifier names, or `null` for a package or a file that is not source. */
export function resolveSpec(from: string, spec: string): string | null {
  let base: string | null = null;
  const alias = ALIASES.find(([prefix]) => spec.startsWith(prefix));
  if (alias) base = alias[1] + spec.slice(alias[0].length);
  else if (spec.startsWith(".")) base = resolve(dirname(from), spec);
  if (!base) return null;
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`];
  return candidates.find((c) => existsSync(c) && statSync(c).isFile() && /\.tsx?$/.test(c)) ?? null;
}

/** Files reachable from `entry` through static, value imports (`import(...)` and `import type`
 *  are not followed). */
export function staticGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const i of importsOf(file)) {
      if (i.dynamic || i.typeOnly) continue;
      const target = resolveSpec(file, i.spec);
      if (target) stack.push(target);
    }
  }
  return seen;
}

const TS_FILE = (name: string) => /\.tsx?$/.test(name) && !name.endsWith(".d.ts");

/** Every `.ts`/`.tsx` file under `dir` (or every file `keep` accepts), skipping fixtures and
 *  `node_modules`. */
export function sourceFiles(dir: string, keep: (name: string) => boolean = TS_FILE): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules" || name === "fixtures") continue;
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p, keep));
    else if (keep(name)) out.push(p);
  }
  return out;
}

/** `src` or `features/<id>`: the folder a file belongs to for the boundary rule. */
export function boundaryOf(file: string): string {
  const rel = relative(DESKTOP, file).split("/");
  return rel[0] === "features" ? `features/${rel[1]}` : rel[0]!;
}
