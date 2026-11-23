// The spellcheck IPC: manifest, generated bindings and typed client name the same commands, and
// every wrapper sends the argument names the Rust commands read.
// @vitest-environment jsdom
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { describeFeatureIpc } from "@tests/helpers/feature-ipc";
import { afterEach, describe, expect, it } from "vite-plus/test";
import manifest from "../feature.json";
import * as ipc from "../web/ipc";

afterEach(() => clearMocks());

describeFeatureIpc({
  id: manifest.id,
  commands: manifest.rust.commands,
  calls: {
    spellcheck_check: () => ipc.check({ path: "a.md", text: "hi", version: 1, language: null }),
    spellcheck_dictionaries: () => ipc.dictionaries(),
    spellcheck_install_dictionary: () => ipc.installDictionary("en"),
    spellcheck_remove_dictionary: () => ipc.removeDictionary("en"),
    spellcheck_personal_words: () => ipc.personalWords(),
    spellcheck_add_word: () => ipc.addWord("w"),
    spellcheck_remove_word: () => ipc.removeWord("w"),
    spellcheck_ignore_word: () => ipc.ignoreWord("a.md", "w"),
    spellcheck_unignore_word: () => ipc.unignoreWord("a.md", "w"),
  },
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
