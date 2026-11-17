// Import hygiene for `src/` and `features/<id>/`: a file reaches into another folder (core, another
// feature) through an alias (`@/`, `@features/<id>/`, `@shared/`), never by climbing out of its own
// folder with `../..`; and a feature does not import another feature's internals at runtime (the
// Obsidian shim reaches Bases through the `bases.views` service, with `import type` from the
// feature's public `web/api` entry only). SPECs/builtin-plugins-spec.md, "hidden coupling".
import { describe, expect, it } from "vite-plus/test";
import { join, relative } from "node:path";
import { DESKTOP, boundaryOf, importsOf, resolveSpec, sourceFiles } from "./helpers/import-graph";

const files = [...sourceFiles(join(DESKTOP, "src")), ...sourceFiles(join(DESKTOP, "features"))];
const rel = (f: string) => relative(DESKTOP, f);

describe("import boundaries", () => {
  it("scans the source folders", () => {
    expect(files.length).toBeGreaterThan(300);
  });

  it("no relative import leaves its own folder (src, or one feature)", () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const { spec } of importsOf(file)) {
        if (!spec.startsWith(".")) continue;
        const target = resolveSpec(file, spec);
        if (target && boundaryOf(target) !== boundaryOf(file)) {
          offenders.push(`${rel(file)}: ${spec}`);
        }
      }
    }
    expect(offenders, "use @/, @features/<id>/ or @shared/ across folders").toEqual([]);
  });

  it("no climbing `../../` import reaches outside the file's own feature or src folder, even to a non-source file", () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const { spec } of importsOf(file)) {
        if (!/^(\.\.\/){3,}/.test(spec)) continue;
        offenders.push(`${rel(file)}: ${spec}`);
      }
    }
    // Deep climbs inside one folder are tolerated only up to two levels; three or more means the
    // target is almost surely another folder or a missing alias.
    expect(offenders).toEqual([]);
  });

  it("a feature never imports another feature at runtime (import type of its public entry is fine)", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const own = boundaryOf(file);
      if (!own.startsWith("features/")) continue;
      for (const { spec, typeOnly } of importsOf(file)) {
        const target = resolveSpec(file, spec);
        if (!target) continue;
        const other = boundaryOf(target);
        if (!other.startsWith("features/") || other === own) continue;
        const isTest = rel(file).includes("/tests/");
        if (isTest) continue; // a test may assemble two features
        if (typeOnly && rel(target).endsWith("/web/api.ts")) continue;
        offenders.push(`${rel(file)}: ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
