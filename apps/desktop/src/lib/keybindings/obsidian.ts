// Obsidian's hotkey shape <-> Writer chords. One mapping for the Obsidian host (plugin hotkeys and
// `app.hotkeyManager`) and for "Import from Obsidian". Obsidian names: `Mod` is Cmd on macOS and
// Ctrl elsewhere, `Meta` is Cmd on macOS and the Windows key elsewhere, `Ctrl`, `Alt`, `Shift`;
// the key is a `KeyboardEvent.key`. Those are Writer's chord modifiers too (`chord.ts`).
import { normalizeChord, parseChord } from "./chord";

export interface ObsidianHotkey {
  modifiers: string[];
  key: string;
}

const MODIFIERS = new Set(["Mod", "Meta", "Ctrl", "Alt", "Shift"]);

/** The chord of an Obsidian hotkey, or null when it has an unknown modifier or an unusable key. */
export function obsidianToChord(h: ObsidianHotkey): string | null {
  if (!Array.isArray(h?.modifiers) || typeof h.key !== "string") return null;
  if (!h.modifiers.every((m) => MODIFIERS.has(m))) return null;
  try {
    return normalizeChord([...h.modifiers, h.key].join("+"));
  } catch {
    return null;
  }
}

/** The Obsidian hotkey of a chord (letters in lower case, as Obsidian stores them). */
export function chordToObsidian(chord: string): ObsidianHotkey {
  const c = parseChord(chord);
  return {
    modifiers: [
      ...(c.mod ? ["Mod"] : []),
      ...(c.meta ? ["Meta"] : []),
      ...(c.ctrl ? ["Ctrl"] : []),
      ...(c.alt ? ["Alt"] : []),
      ...(c.shift ? ["Shift"] : []),
    ],
    key: /^[A-Z]$/.test(c.key) ? c.key.toLowerCase() : c.key,
  };
}
