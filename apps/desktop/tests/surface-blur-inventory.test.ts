// Inventory guard: floating surfaces blur their backdrop only through the tokens `--surface-blur*`
// (`src/App.css`), so one rule can make every surface opaque on Linux (no window vibrancy there).
// A raw `backdrop-filter: blur(...)` or Tailwind `backdrop-blur-*` is a second copy that stays
// blurred and see-through. A token's value lives in the `--surface-blur*` declarations only.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { DESKTOP } from "./helpers/import-graph";

const RAW = /backdrop-filter:\s*blur\(|backdrop-blur/;

function files(dir: string): string[] {
  return (readdirSync(dir) as string[]).flatMap((name: string) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : files(path);
    return /\.(css|tsx?)$/.test(name) ? [path] : [];
  });
}

describe("surface blur inventory", () => {
  const all = [...files(join(DESKTOP, "src")), ...files(join(DESKTOP, "features"))].filter(
    (f) => !f.includes("/tests/"),
  );

  it("scans the source folders", () => {
    expect(all.length).toBeGreaterThan(300);
  });

  it("no file blurs a backdrop outside the tokens", () => {
    const offenders = all
      .map((f) => relative(DESKTOP, f))
      .filter((rel) =>
        (readFileSync(join(DESKTOP, rel), "utf8") as string)
          .split("\n")
          // Comments may name the properties; code may not.
          .filter((line: string) => !/^\s*(\/\*|\*|\/\/)/.test(line))
          .some((line: string) => RAW.test(line)),
      );
    expect(offenders).toEqual([]);
  });

  it("Linux makes every blur token none and the plates opaque", () => {
    const css = readFileSync(join(DESKTOP, "src/App.css"), "utf8");
    const tokens = [...css.matchAll(/^\s*(--surface-blur[\w-]*):\s*blur\(/gm)].map((m) => m[1]!);
    expect(tokens.length).toBeGreaterThan(0);
    const linux = css.slice(css.indexOf(':root[data-platform="linux"]'));
    for (const t of tokens) expect(linux).toMatch(new RegExp(`${t}:\\s*none`));
    expect(linux).toMatch(/--surface-plate-mix:\s*100%/);
    expect(linux).toMatch(/--surface-plate-floor:\s*100%/);
  });
});
