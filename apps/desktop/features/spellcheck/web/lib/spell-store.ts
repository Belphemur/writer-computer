// The feature's one piece of shared UI state. `epoch` goes up whenever the answer to "what is
// wrong in this note" may have changed without the note changing (a dictionary installed or
// removed, a word added, a rule ignored, a language chosen, the checker switched): every editor's
// linter listens and checks again. `results` is the latest answer per note for the status item;
// `overrides` the language the user picked for a note this session.
import { create } from "zustand";
import type { BlockLanguage } from "../ipc";

export interface NoteResult {
  blocks: BlockLanguage[];
  /** Languages a block is in that nothing can check (no dictionary installed). */
  missing: string[];
}

interface SpellState {
  epoch: number;
  results: Record<string, NoteResult>;
  overrides: Record<string, string>;
  bump: () => void;
  setResult: (path: string, result: NoteResult) => void;
  /** `null` clears the override (automatic again). */
  setOverride: (path: string, lang: string | null) => void;
  reset: () => void;
}

export const useSpellStore = create<SpellState>((set) => ({
  epoch: 0,
  results: {},
  overrides: {},
  bump: () => set((s) => ({ epoch: s.epoch + 1 })),
  setResult: (path, result) => set((s) => ({ results: { ...s.results, [path]: result } })),
  setOverride: (path, lang) =>
    set((s) => {
      const overrides = { ...s.overrides };
      if (lang === null) delete overrides[path];
      else overrides[path] = lang;
      return { overrides, epoch: s.epoch + 1 };
    }),
  reset: () => set({ epoch: 0, results: {}, overrides: {} }),
}));
