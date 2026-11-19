// The spellcheck IPC: manifest, generated bindings and typed client name the same commands, and
// every wrapper sends the argument names the Rust commands read.
// @vitest-environment jsdom
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, describe, expect, it } from "vite-plus/test";
import manifest from "../feature.json";
import { commands } from "../web/bindings";
import * as ipc from "../web/ipc";

afterEach(() => clearMocks());

const snake = (camel: string) => camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

describe("the spellcheck commands", () => {
  it("are the same set in the manifest and in the generated bindings", () => {
    expect(Object.keys(commands).map(snake).sort()).toEqual([...manifest.rust.commands].sort());
  });

  it("are invoked by the generated bindings on the plugin route", () => {
    for (const [name, fn] of Object.entries(commands)) {
      expect(fn.toString(), name).toContain(`"plugin:spellcheck|${snake(name)}"`);
    }
  });
});

describe("the wrappers", () => {
  it("send each call to its command with the argument names Rust reads", async () => {
    const seen: [string, unknown][] = [];
    mockIPC((cmd, args) => {
      seen.push([cmd, args]);
      return cmd.endsWith("spellcheck_check")
        ? { findings: [], blocks: [], missing: [], stale: false }
        : [];
    });
    await ipc.check({ path: "a.md", text: "hi", version: 1, language: null });
    await ipc.dictionaries();
    await ipc.addWord("Zettel");
    await ipc.removeWord("Zettel");
    await ipc.personalWords();
    await ipc.ignoreWord("a.md", "Zettel");
    await ipc.unignoreWord("a.md", "Zettel");
    expect(seen).toEqual([
      [
        "plugin:spellcheck|spellcheck_check",
        { request: { path: "a.md", text: "hi", version: 1, language: null } },
      ],
      ["plugin:spellcheck|spellcheck_dictionaries", {}],
      ["plugin:spellcheck|spellcheck_add_word", { word: "Zettel" }],
      ["plugin:spellcheck|spellcheck_remove_word", { word: "Zettel" }],
      ["plugin:spellcheck|spellcheck_personal_words", {}],
      ["plugin:spellcheck|spellcheck_ignore_word", { path: "a.md", word: "Zettel" }],
      ["plugin:spellcheck|spellcheck_unignore_word", { path: "a.md", word: "Zettel" }],
    ]);
  });
});
