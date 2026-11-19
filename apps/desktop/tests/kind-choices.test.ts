import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  COMMANDS_KIND,
  kindChoices,
  stepKind,
} from "../src/components/command-palette/kind-choices";

const kind = (id: string) => ({ id, label: id.toUpperCase(), icon: "X" });

describe("kindChoices", () => {
  it("is All, the kinds in order, then Commands", () => {
    expect(kindChoices([kind("note"), kind("pdf")], true).map((c) => c.id)).toEqual([
      null,
      "note",
      "pdf",
      COMMANDS_KIND,
    ]);
    expect(kindChoices([kind("note"), kind("pdf")]).map((c) => c.id)).toEqual([
      null,
      "note",
      "pdf",
    ]);
  });

  it("is empty while fewer than two things narrow the list", () => {
    expect(kindChoices([])).toEqual([]);
    expect(kindChoices([kind("note")])).toEqual([]);
    expect(kindChoices([], true)).toEqual([]);
    expect(kindChoices([kind("note")], true).map((c) => c.id)).toEqual([
      null,
      "note",
      COMMANDS_KIND,
    ]);
  });

  it("never collides with a registry kind id", () => {
    const rust = join(import.meta.dirname, "../src-tauri");
    const sources = [
      join(rust, "src/index/kinds.rs"),
      ...readdirSync(join(import.meta.dirname, "../features")).map((f: string) =>
        join(import.meta.dirname, "../features", f, "rust/mod.rs"),
      ),
    ];
    let ids = 0;
    for (const file of sources) {
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      for (const m of text.matchAll(/^\s*id: "([^"]+)",/gm)) {
        ids += 1;
        expect(m[1]).not.toBe(COMMANDS_KIND);
      }
    }
    expect(ids).toBeGreaterThanOrEqual(2); // the scan really found the registry
  });
});

describe("stepKind", () => {
  const choices = kindChoices([kind("note"), kind("pdf")], true);
  it("moves forward and wraps to All", () => {
    expect(stepKind(choices, null, 1)).toBe("note");
    expect(stepKind(choices, "pdf", 1)).toBe(COMMANDS_KIND);
    expect(stepKind(choices, COMMANDS_KIND, 1)).toBeNull();
  });
  it("moves backward and wraps to the last", () => {
    expect(stepKind(choices, "note", -1)).toBeNull();
    expect(stepKind(choices, null, -1)).toBe(COMMANDS_KIND);
  });
  it("treats a stale id as All and leaves an empty list alone", () => {
    expect(stepKind(choices, "gone", 1)).toBe("note");
    expect(stepKind([], "x", 1)).toBe("x");
  });
});
