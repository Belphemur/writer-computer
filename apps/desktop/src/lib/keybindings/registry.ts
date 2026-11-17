// The keybinding registry: every app shortcut is one entry (id, default keys, context, handler,
// description, category) and `use-keyboard-shortcuts.ts` iterates it. Core bindings and built-in
// feature contributions go through the same `add`, which refuses a chord that is already taken so
// a conflict is an error at registration, not a silent "first one wins".
import { OwnedRegistry } from "@/lib/owned-registry";
import { detectPlatform, type Platform } from "@/lib/platform";
import {
  chordMatches,
  formatChord,
  normalizeChord,
  parseChord,
  type Chord,
  type ChordMatchOptions,
} from "./chord";
import { WHEN, type WhenName } from "./when";

export type KeybindingCategory = "Navigation" | "Tabs" | "View" | "Agent" | "Feature";

export interface Keybinding extends ChordMatchOptions {
  /** The command id this key runs. When the palette has a command with this id it shows the key. */
  id: string;
  /** Default chords, `Mod+Shift+T` style. The first one is the one shown. */
  keys: readonly string[];
  /** Plain words for the shortcut list and conflict messages. */
  description: string;
  category: KeybindingCategory;
  /** Context that must hold for the binding to match; omitted means always. */
  when?: WhenName;
  /** `capture` runs before CodeMirror sees the key and stops it from going further. */
  phase?: "bubble" | "capture";
  /** Runs after `preventDefault` (and `stopPropagation` in the capture phase). */
  run: (e: KeyboardEvent) => void;
}

interface Owned extends Keybinding {
  owner: string;
}

// Two bindings may share a chord only when both name a different context (the author declares them
// exclusive); an unconditional binding overlaps every context.

/** Chords the OS or the native menu owns; an app binding on them could never fire reliably. */
const RESERVED: readonly string[] = ["Mod+Q", "Mod+,", "Mod+H", "Mod+M"];

export class KeybindingConflictError extends Error {}

export class KeybindingRegistry {
  private items = new OwnedRegistry<Owned>();

  constructor(
    private conditions: Record<WhenName, (e: KeyboardEvent) => boolean> = WHEN,
    private platform: () => Platform = detectPlatform,
  ) {}

  /** Adds a binding, or throws `KeybindingConflictError` naming the chord and who has it. */
  add(owner: string, binding: Keybinding): () => void {
    const taken = this.items.list().find((b) => b.id === binding.id);
    if (taken)
      throw new KeybindingConflictError(
        `Keybinding id "${binding.id}" is already used by ${taken.owner}`,
      );
    const mine = binding.keys.map(normalizeChord);
    const dup = mine.find((k, i) => mine.indexOf(k) !== i);
    if (dup)
      throw new KeybindingConflictError(`${this.show(dup)} is listed twice for "${binding.id}"`);
    for (const key of mine) {
      if (RESERVED.includes(key)) {
        throw new KeybindingConflictError(
          `${this.show(key)} is reserved by the system and cannot be bound ("${binding.id}")`,
        );
      }
      const other = this.items
        .list()
        .find(
          (b) =>
            (!b.when || !binding.when || b.when === binding.when) &&
            b.keys.some((k) => normalizeChord(k) === key),
        );
      if (other) {
        throw new KeybindingConflictError(
          `${this.show(key)} is already bound to "${other.id}" (${other.owner}); cannot bind it to "${binding.id}" (${owner})`,
        );
      }
    }
    return this.items.add(binding.id, { ...binding, owner });
  }

  removeOwner(owner: string): number {
    return this.items.removeOwner(owner);
  }

  list(): readonly Keybinding[] {
    return this.items.list();
  }

  /** The first binding that matches `e` in this phase and whose context holds. */
  find(e: KeyboardEvent, phase: "bubble" | "capture"): Keybinding | undefined {
    return this.items
      .list()
      .find(
        (b) =>
          (b.phase ?? "bubble") === phase &&
          (!b.when || this.conditions[b.when](e)) &&
          parsedKeys(b).some((c) => chordMatches(c, e, b)),
      );
  }

  /** The key to show next to a command, in the user's platform spelling; undefined if unbound. */
  shortcutFor(commandId: string): string | undefined {
    const b = this.items.list().find((x) => x.id === commandId);
    return b?.keys[0] ? this.show(b.keys[0]) : undefined;
  }

  private show(chord: string): string {
    return formatChord(chord, this.platform());
  }

  subscribe(listener: () => void): () => void {
    return this.items.subscribe(listener);
  }
}

const parsed = new WeakMap<Keybinding, Chord[]>();
function parsedKeys(b: Keybinding): Chord[] {
  let c = parsed.get(b);
  if (!c) parsed.set(b, (c = b.keys.map(parseChord)));
  return c;
}

/** The app's one keybinding registry. */
export const keybindings = new KeybindingRegistry();
