// The typed client of the spellcheck commands (`plugin:spellcheck|*`, Rust half in `../rust/`).
// The wire types come from the generated `bindings.ts` (tauri-specta), so a field change in Rust
// is a type error here; it owns the route and the argument names, and this is its only importer.
// Tests mock this module, so nothing else reaches the backend.
import type * as wire from "./bindings";
import { commands } from "./bindings";

export type Finding = wire.Finding;
export type FindingKind = wire.Kind;
export type BlockLanguage = wire.BlockLanguage;
export type CheckRequest = wire.CheckRequest;
export type CheckResponse = wire.CheckResponse;
export type DictionaryInfo = wire.DictionaryInfo;
export type Installed = wire.Installed;

/** Checks a note's text; findings are UTF-16 offsets into `request.text`. */
export function check(request: CheckRequest): Promise<CheckResponse> {
  return commands.spellcheckCheck(request);
}

/** Every dictionary of the pinned catalog, installed or not. */
export function dictionaries(): Promise<DictionaryInfo[]> {
  return commands.spellcheckDictionaries();
}

/** Downloads one dictionary: the feature's only network use, always started by the user. */
export function installDictionary(id: string): Promise<Installed> {
  return commands.spellcheckInstallDictionary(id);
}

export async function removeDictionary(id: string): Promise<void> {
  await commands.spellcheckRemoveDictionary(id);
}

export function personalWords(): Promise<string[]> {
  return commands.spellcheckPersonalWords();
}

export function addWord(word: string): Promise<string[]> {
  return commands.spellcheckAddWord(word);
}

export function removeWord(word: string): Promise<string[]> {
  return commands.spellcheckRemoveWord(word);
}

/** Stops flagging `word` in one note (vault-relative `path`), on this device only. */
export function ignoreWord(path: string, word: string): Promise<string[]> {
  return commands.spellcheckIgnoreWord(path, word);
}

export function unignoreWord(path: string, word: string): Promise<string[]> {
  return commands.spellcheckUnignoreWord(path, word);
}
