// The typed client of the spellcheck commands (`plugin:spellcheck|*`, Rust half in `../rust/`).
// The wire types come from the generated `bindings.ts` (tauri-specta), so a field change in Rust
// is a type error here; this is the only importer of it and the only caller of `featureInvoke`.
// Tests mock this module, so nothing else reaches the backend.
import { featureInvoke } from "@/lib/features/ipc";
import manifest from "../feature.json";
import type * as wire from "./bindings";

export type Finding = wire.Finding;
export type FindingKind = wire.Kind;
export type BlockLanguage = wire.BlockLanguage;
export type CheckRequest = wire.CheckRequest;
export type CheckResponse = wire.CheckResponse;
export type DictionaryInfo = wire.DictionaryInfo;
export type Installed = wire.Installed;

export interface SpellcheckCommands {
  spellcheck_check: { args: { request: CheckRequest }; result: CheckResponse };
  spellcheck_dictionaries: { args: undefined; result: DictionaryInfo[] };
  spellcheck_install_dictionary: { args: { id: string }; result: Installed };
  spellcheck_remove_dictionary: { args: { id: string }; result: null };
  spellcheck_personal_words: { args: undefined; result: string[] };
  spellcheck_add_word: { args: { word: string }; result: string[] };
  spellcheck_remove_word: { args: { word: string }; result: string[] };
  spellcheck_ignore_word: { args: { path: string; word: string }; result: string[] };
  spellcheck_unignore_word: { args: { path: string; word: string }; result: string[] };
}

const call = featureInvoke<SpellcheckCommands>(manifest.id, manifest.rust.commands);

/** Checks a note's text; findings are UTF-16 offsets into `request.text`. */
export function check(request: CheckRequest): Promise<CheckResponse> {
  return call("spellcheck_check", { request });
}

/** Every dictionary of the pinned catalog, installed or not. */
export function dictionaries(): Promise<DictionaryInfo[]> {
  return call("spellcheck_dictionaries");
}

/** Downloads one dictionary: the feature's only network use, always started by the user. */
export function installDictionary(id: string): Promise<Installed> {
  return call("spellcheck_install_dictionary", { id });
}

export async function removeDictionary(id: string): Promise<void> {
  await call("spellcheck_remove_dictionary", { id });
}

export function personalWords(): Promise<string[]> {
  return call("spellcheck_personal_words");
}

export function addWord(word: string): Promise<string[]> {
  return call("spellcheck_add_word", { word });
}

export function removeWord(word: string): Promise<string[]> {
  return call("spellcheck_remove_word", { word });
}

/** Stops flagging `word` in one note (vault-relative `path`), on this device only. */
export function ignoreWord(path: string, word: string): Promise<string[]> {
  return call("spellcheck_ignore_word", { path, word });
}

export function unignoreWord(path: string, word: string): Promise<string[]> {
  return call("spellcheck_unignore_word", { path, word });
}
