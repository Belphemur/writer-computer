// The spellcheck IPC: manifest, generated bindings and typed client name the same commands, and
// every wrapper sends the argument names the Rust commands read.
// @vitest-environment jsdom
import { describeFeatureIpc } from "@tests/helpers/feature-ipc";
import manifest from "../feature.json";
import * as ipc from "../web/ipc";

describeFeatureIpc({
  id: manifest.id,
  commands: manifest.rust.commands,
  calls: {
    spellcheck_check: {
      call: () => ipc.check({ path: "p1", text: "t1", version: 7, language: null }),
      args: { request: { path: "p1", text: "t1", version: 7, language: null } },
    },
    spellcheck_dictionaries: { call: () => ipc.dictionaries(), args: {} },
    spellcheck_install_dictionary: {
      call: () => ipc.installDictionary("id1"),
      args: { id: "id1" },
    },
    spellcheck_remove_dictionary: { call: () => ipc.removeDictionary("id1"), args: { id: "id1" } },
    spellcheck_personal_words: { call: () => ipc.personalWords(), args: {} },
    spellcheck_add_word: { call: () => ipc.addWord("w1"), args: { word: "w1" } },
    spellcheck_remove_word: { call: () => ipc.removeWord("w1"), args: { word: "w1" } },
    spellcheck_ignore_word: {
      call: () => ipc.ignoreWord("p1", "w1"),
      args: { path: "p1", word: "w1" },
    },
    spellcheck_unignore_word: {
      call: () => ipc.unignoreWord("p1", "w1"),
      args: { path: "p1", word: "w1" },
    },
  },
});
