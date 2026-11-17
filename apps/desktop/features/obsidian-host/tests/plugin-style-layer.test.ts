// Plugin stylesheets live in `@layer plugins` so a plugin's unlayered `.hidden { display: none }`
// cannot beat Writer's Tailwind utilities (unlayered CSS beats every layer). jsdom has no cascade
// layers, so these assert the wrapping and the declared order, not the computed style.
// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { domStyleSink, layerPluginCss } from "../web/host/loader";

describe("plugin styles are layered", () => {
  it("wraps the text in the plugins layer", () => {
    expect(layerPluginCss(".hidden{display:none}")).toBe(
      "@layer plugins {\n.hidden{display:none}\n}",
    );
  });

  it("hoists leading @import rules into the same layer", () => {
    const out = layerPluginCss(
      "/* c */\n@import url(\"a.css\");\n@import 'b.css' screen;\n.x{color:red}",
    );
    expect(
      out.startsWith(
        "@import url(\"a.css\") layer(plugins);\n@import 'b.css' layer(plugins) screen;\n",
      ),
    ).toBe(true);
    expect(out).toContain("@layer plugins {");
    expect(out.indexOf("@import")).toBeLessThan(out.indexOf("@layer plugins {"));
    expect(out.slice(out.indexOf("@layer plugins {"))).not.toContain("@import");
  });

  it("injects the layered text", () => {
    const remove = domStyleSink.add("p", ".hidden{display:none}");
    const el = document.querySelector("style[data-writer-plugin='p']")!;
    expect(el.textContent).toMatch(/^@layer plugins \{/);
    remove();
    expect(document.querySelector("style[data-writer-plugin='p']")).toBeNull();
  });

  it("declares the layer order before Tailwind's, with plugins below utilities", () => {
    const css = readFileSync(resolve(process.cwd(), "src/App.css"), "utf8");
    const decl = css.indexOf("@layer theme, base, components, plugins, utilities;");
    expect(decl).toBeGreaterThanOrEqual(0);
    expect(decl).toBeLessThan(css.indexOf('@import "tailwindcss"'));
  });
});
