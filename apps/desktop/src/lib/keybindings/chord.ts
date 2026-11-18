// Key chords as data: parse "Mod+Shift+T", normalize it for conflict checks, format it for display
// and match it against a KeyboardEvent. The one place that knows what a chord string means.
import type { Platform } from "@/lib/platform";

/**
 * Modifier tokens. `Mod` is Cmd on macOS and Ctrl elsewhere, but the handlers have always accepted
 * either (`metaKey || ctrlKey`), and so does matching. `Meta` is the Command key only and `Ctrl`
 * the Control key only (Ctrl+Tab cycles tabs, Cmd+[ is history).
 */
const MODIFIERS = ["Mod", "Meta", "Ctrl", "Alt", "Shift"] as const;
type Modifier = (typeof MODIFIERS)[number];

export interface Chord {
  mod: boolean;
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** `KeyboardEvent.key` value; a single letter is stored uppercase. */
  key: string;
}

/** What a binding adds on top of its chords when matching (the quirks the old `if` chain had). */
export interface ChordMatchOptions {
  /** Shift state is ignored: `Cmd++` is `Shift+=` on a US layout. */
  looseShift?: boolean;
  /** Extra `KeyboardEvent.key` values that count as the chord's key (`_` is Shift+`-`). */
  alsoKeys?: readonly string[];
  /** Extra `KeyboardEvent.code` values that count as the chord's key (numpad). */
  physicalKeys?: readonly string[];
  /** A letter chord also matches its physical key when the layout types a non-Latin letter. */
  layoutIndependent?: boolean;
}

const KEY = /^(?:.|[A-Za-z][A-Za-z0-9]+)$/;
const isLetter = (s: string) => /^[a-z]$/i.test(s);
const isDigit = (s: string) => /^[0-9]$/.test(s);

/** The grammar is pinned by `shared/chord-vectors.json` (the Rust validation reads the same file). */
export function parseChord(chord: string): Chord {
  const c: Chord = { mod: false, meta: false, ctrl: false, alt: false, shift: false, key: "" };
  let rest = chord;
  for (;;) {
    const m = /^(Mod|Meta|Ctrl|Alt|Shift)\+(.+)$/.exec(rest);
    if (!m) break;
    c[m[1]!.toLowerCase() as Lowercase<Modifier>] = true;
    rest = m[2]!;
  }
  if (!KEY.test(rest)) throw new Error(`Invalid key chord "${chord}"`);
  c.key = isLetter(rest) ? rest.toUpperCase() : rest;
  return c;
}

/** Canonical spelling, equal for chords that mean the same thing: `Shift+Mod+t` -> `Mod+Shift+T`. */
export function normalizeChord(chord: string): string {
  const c = parseChord(chord);
  return [
    ...(c.mod ? ["Mod"] : []),
    ...(c.meta ? ["Meta"] : []),
    ...(c.ctrl ? ["Ctrl"] : []),
    ...(c.alt ? ["Alt"] : []),
    ...(c.shift ? ["Shift"] : []),
    c.key,
  ].join("+");
}

/** What the user sees: `⌘⇧T` on macOS, `Ctrl+Shift+T` elsewhere. */
export function formatChord(chord: string, platform: Platform): string {
  const c = parseChord(chord);
  const key = c.key === " " ? "Space" : c.key.startsWith("Arrow") ? c.key.slice(5) : c.key;
  if (platform === "macos") {
    return `${c.ctrl ? "⌃" : ""}${c.alt ? "⌥" : ""}${c.shift ? "⇧" : ""}${c.mod || c.meta ? "⌘" : ""}${key}`;
  }
  return [
    ...(c.mod || c.ctrl ? ["Ctrl"] : []),
    ...(c.meta ? ["Win"] : []),
    ...(c.alt ? ["Alt"] : []),
    ...(c.shift ? ["Shift"] : []),
    key,
  ].join("+");
}

export function chordMatches(
  c: Chord,
  e: KeyboardEvent,
  { looseShift, alsoKeys, physicalKeys, layoutIndependent }: ChordMatchOptions = {},
): boolean {
  const anyMod = e.metaKey || e.ctrlKey;
  const modOk = c.mod
    ? anyMod
    : c.meta
      ? e.metaKey && !e.ctrlKey
      : c.ctrl
        ? e.ctrlKey && !e.metaKey
        : !anyMod;
  if (!modOk || e.altKey !== c.alt || (!looseShift && e.shiftKey !== c.shift)) return false;
  if (e.key === c.key || alsoKeys?.includes(e.key) || physicalKeys?.includes(e.code)) return true;
  if (isLetter(c.key)) {
    if (e.key.toLowerCase() === c.key.toLowerCase()) return true;
    // A non-Latin layout reports another letter as `key`; the physical key is still the one.
    return !!layoutIndependent && !isLetter(e.key) && e.code === `Key${c.key}`;
  }
  // Option+digit types a symbol on macOS: the digit row is the physical key.
  return !!layoutIndependent && isDigit(c.key) && e.code === `Digit${c.key}`;
}

/** Keys that are only a modifier (or a lock): pressing one alone is not a chord. */
const LONE_KEYS = new Set([
  "Meta",
  "Control",
  "Alt",
  "AltGraph",
  "Shift",
  "CapsLock",
  "Fn",
  "FnLock",
  "OS",
  "Super",
  "Hyper",
  "Dead",
  "Unidentified",
]);

/**
 * The chord a key press spells, for the recorder: `Mod` is the platform's own key (Cmd on macOS,
 * Ctrl elsewhere), the other one stays `Ctrl` / `Meta`. Null for a lone modifier. With Alt held the
 * physical letter or digit is used, because Option+A types `å` on macOS.
 */
export function eventToChord(
  e: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  platform: Platform,
): string | null {
  if (LONE_KEYS.has(e.key)) return null;
  let key = e.key;
  if (e.altKey) {
    const physical = /^Key([A-Z])$/.exec(e.code) ?? /^Digit([0-9])$/.exec(e.code);
    if (physical) key = physical[1]!;
  }
  if (!KEY.test(key)) return null;
  const mac = platform === "macos";
  const mods = [
    ...(mac ? (e.metaKey ? ["Mod"] : []) : e.ctrlKey ? ["Mod"] : []),
    ...(mac && e.ctrlKey ? ["Ctrl"] : []),
    ...(!mac && e.metaKey ? ["Meta"] : []),
    ...(e.altKey ? ["Alt"] : []),
    ...(e.shiftKey ? ["Shift"] : []),
  ];
  return normalizeChord([...mods, key].join("+"));
}

/** Does the chord carry a modifier other than Shift, or is it a function key? A bare letter would
 *  swallow typing everywhere, so nothing else may be bound. */
export function isBindableChord(chord: string): boolean {
  const c = parseChord(chord);
  return c.mod || c.meta || c.ctrl || c.alt || /^F\d{1,2}$/.test(c.key);
}
