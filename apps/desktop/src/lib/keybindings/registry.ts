// The keybinding registry: every app command with a key (or without one yet) is one entry (id,
// default keys, context, handler, description, category) and `use-keyboard-shortcuts.ts` iterates
// it. It is the only list of commands-and-keys and the only matcher (spec SPECs/hotkeys-spec.md).
//
// Three layers decide what a key does:
//  1. defaults: an entry's `keys`, a plain list or one list per OS (`{ mac, windows, linux, other }`);
//     core bindings and built-in features go through `add`, which refuses a chord that is already
//     taken so a default conflict is an error at registration, not a silent "first one wins";
//  2. command entries (`addCommand`): a palette command with no default key still has an entry, so
//     the user can give it one;
//  3. the user's overrides for the current OS (`setOverrides`, from `hotkeys.json`): a list replaces
//     the defaults, `[]` removes them. Overrides claim their chords first, so a key the user chose
//     beats any default (including one a later plugin registers).
// What matches is the resolved ("effective") keys; the palette, the Hotkeys page and the Obsidian
// plugins all read them from here.
import { OwnedRegistry } from "@/lib/owned-registry";
import { detectPlatform, type Platform } from "@/lib/platform";
import {
  chordMatches,
  formatChord,
  isBindableChord,
  normalizeChord,
  parseChord,
  type Chord,
  type ChordMatchOptions,
} from "./chord";
import { WHEN, type WhenName } from "./when";

export type KeybindingCategory =
  | "Navigation"
  | "Tabs"
  | "View"
  | "Agent"
  | "Feature"
  | "Command"
  | "Plugin";

/** The OS names of `hotkeys.json` and of a per-OS default. */
export type OsKey = "mac" | "windows" | "linux";
/** One list per OS; `other` covers any OS not named. */
export type PlatformKeys = { [K in OsKey | "other"]?: readonly string[] };
export type KeySpec = readonly string[] | PlatformKeys;

export const osKey = (p: Platform): OsKey => (p === "macos" ? "mac" : p);

/** The default chords of `spec` on `os` (`Mod` is Cmd on macOS and Ctrl elsewhere). */
export function resolveKeys(spec: KeySpec, os: OsKey): readonly string[] {
  if (Array.isArray(spec)) return spec as readonly string[];
  const per = spec as PlatformKeys;
  return per[os] ?? per.other ?? [];
}

export interface Keybinding extends ChordMatchOptions {
  /** The command id this key runs. When the palette has a command with this id it shows the key. */
  id: string;
  /** Default chords, `Mod+Shift+T` style (the first one is shown), or one list per OS. */
  keys: KeySpec;
  /** Plain words for the shortcut list and conflict messages. */
  description: string;
  category: KeybindingCategory;
  /** The Hotkeys page group when it is not derived from the owner (a plugin's name). */
  group?: string;
  /** `false`: the page shows the keys but cannot change them (the handler reads the key itself). */
  rebindable?: boolean;
  /** Context that must hold for the binding to match; omitted means always. */
  when?: WhenName;
  /** Checked after the chord and `when` match, at key time: `false` lets the key fall through to
   *  the editor, like an unavailable command (a plugin's `checkCallback`, a palette `when`). It
   *  never affects conflicts: those depend on `when` only. */
  available?: () => boolean;
  /** `capture` runs before CodeMirror sees the key and stops it from going further. */
  phase?: "bubble" | "capture";
  /** Runs after `preventDefault` (and `stopPropagation` in the capture phase). */
  run: (e: KeyboardEvent) => void;
}

/** An entry as listed: the binding, who registered it, and whether it is a keyless command entry. */
export interface KeybindingEntry extends Keybinding {
  owner: string;
  /** Added by `addCommand`: it has no default keys and yields to a real binding of the same id. */
  command?: boolean;
}

// Two bindings may share a chord only when both name a different context (the author declares them
// exclusive); an unconditional binding overlaps every context.
const overlap = (a?: WhenName, b?: WhenName) => !a || !b || a === b;

/** Chords the OS or the native menu owns; an app binding on them could never fire reliably. */
const RESERVED: readonly string[] = ["Mod+Q", "Mod+,", "Mod+H", "Mod+M"];

export class KeybindingConflictError extends Error {}

/** A key that was refused, with the one-line reason the recorder shows. */
export type ChordRefusal = "reserved" | "needs-modifier";

export class KeybindingRegistry {
  private items = new OwnedRegistry<KeybindingEntry>();
  private overrides = new Map<string, readonly string[]>();
  private resolved: Map<string, readonly string[]> | null = null;
  private overrideListeners = new Set<() => void>();

  constructor(
    private conditions: Record<WhenName, (e: KeyboardEvent) => boolean> = WHEN,
    private platform: () => Platform = detectPlatform,
  ) {
    // First subscriber, so every other listener sees the cache already dropped.
    this.items.subscribe(() => (this.resolved = null));
  }

  private os(): OsKey {
    return osKey(this.platform());
  }

  /**
   * Adds a binding, or throws `KeybindingConflictError` naming the chord and who has it. Default
   * keys only: the user's overrides never make a registration fail. `strict: false` (plugins,
   * whose keys are not ours to vouch for) skips the conflict and reserved checks; such a key just
   * does not take effect when another binding already has it.
   */
  add(owner: string, binding: Keybinding, { strict = true } = {}): () => void {
    const taken = this.items.get(binding.id);
    if (taken && !taken.command)
      throw new KeybindingConflictError(
        `Keybinding id "${binding.id}" is already used by ${taken.owner}`,
      );
    const mine = resolveKeys(binding.keys, this.os()).map(normalizeChord);
    if (strict) {
      const dup = mine.find((k, i) => mine.indexOf(k) !== i);
      if (dup)
        throw new KeybindingConflictError(
          `${this.format(dup)} is listed twice for "${binding.id}"`,
        );
      for (const key of mine) {
        if (RESERVED.includes(key)) {
          throw new KeybindingConflictError(
            `${this.format(key)} is reserved by the system and cannot be bound ("${binding.id}")`,
          );
        }
        const other = this.items
          .list()
          .find(
            (b) =>
              b.id !== binding.id &&
              overlap(b.when, binding.when) &&
              resolveKeys(b.keys, this.os()).some((k) => normalizeChord(k) === key),
          );
        if (other) {
          throw new KeybindingConflictError(
            `${this.format(key)} is already bound to "${other.id}" (${other.owner}); cannot bind it to "${binding.id}" (${owner})`,
          );
        }
      }
    }
    return this.items.add(binding.id, { ...binding, owner });
  }

  /**
   * A command that has no default key, so it can be given one. A no-op when the id is already
   * there (a real binding of the same id wins, and replaces a command entry added before it).
   */
  addCommand(
    owner: string,
    command: Pick<Keybinding, "id" | "description" | "run"> &
      Partial<Pick<Keybinding, "group" | "available">>,
  ): void {
    if (this.items.has(command.id)) return;
    this.items.add(command.id, { ...command, keys: [], category: "Command", owner, command: true });
  }

  remove(id: string): boolean {
    return this.items.remove(id);
  }

  removeOwner(owner: string): number {
    return this.items.removeOwner(owner);
  }

  list(): readonly KeybindingEntry[] {
    return this.items.list();
  }

  get(id: string): KeybindingEntry | undefined {
    return this.items.get(id);
  }

  // ---------------------------------------------------------------- effective keys

  /**
   * id -> the chords that actually match: the user's keys first, then the defaults, each chord
   * given to the first claimant whose context overlaps; reserved and unbindable chords never
   * take effect. Cached until an entry or an override changes.
   */
  private effective(): Map<string, readonly string[]> {
    if (this.resolved) return this.resolved;
    const out = new Map<string, readonly string[]>();
    const claimed: { key: string; when?: WhenName }[] = [];
    const claim = (b: KeybindingEntry, keys: readonly string[]) => {
      const mine: string[] = [];
      for (const raw of keys) {
        let key: string;
        try {
          key = normalizeChord(raw);
        } catch {
          continue; // a stored key this build cannot read is ignored, not fatal
        }
        if (mine.includes(key) || this.refusal(key)) continue;
        if (claimed.some((c) => c.key === key && overlap(c.when, b.when))) continue;
        claimed.push({ key, when: b.when });
        mine.push(key);
      }
      out.set(b.id, mine);
    };
    const entries = this.items.list();
    for (const b of entries) if (this.overrides.has(b.id)) claim(b, this.overrides.get(b.id)!);
    for (const b of entries)
      if (!this.overrides.has(b.id)) claim(b, resolveKeys(b.keys, this.os()));
    return (this.resolved = out);
  }

  /** The chords in force for a command (normalized), the first one is the one to show. */
  effectiveKeys(id: string): readonly string[] {
    return this.effective().get(id) ?? [];
  }

  /** The default chords of a command on this OS (normalized), whatever the user changed. */
  defaultKeys(id: string): readonly string[] {
    const b = this.items.get(id);
    return b ? resolveKeys(b.keys, this.os()).map(normalizeChord) : [];
  }

  isModified(id: string): boolean {
    return this.overrides.has(id);
  }

  /** The first key in the user's platform spelling; undefined if the command is unbound. */
  shortcutFor(commandId: string): string | undefined {
    const first = this.effectiveKeys(commandId)[0];
    return first ? this.format(first) : undefined;
  }

  format(chord: string): string {
    return formatChord(chord, this.platform());
  }

  // ---------------------------------------------------------------- user overrides

  /** Why this chord cannot be bound, or undefined when it can. */
  refusal(chord: string): ChordRefusal | undefined {
    if (RESERVED.includes(normalizeChord(chord))) return "reserved";
    return isBindableChord(chord) ? undefined : "needs-modifier";
  }

  /** Replaces every override (the file's section for this OS). Unknown ids are kept. */
  setOverrides(map: Readonly<Record<string, readonly string[]>>): void {
    this.overrides = new Map(Object.entries(map));
    this.changedOverrides();
  }

  /** The overrides as a plain object (what is written back to the file for this OS). */
  overridesSnapshot(): Record<string, readonly string[]> {
    return Object.fromEntries(this.overrides);
  }

  /** The command that already has `chord` in a context overlapping `id`'s, if any. */
  conflictFor(id: string, chord: string): KeybindingEntry | undefined {
    const key = normalizeChord(chord);
    const when = this.items.get(id)?.when;
    const eff = this.effective();
    return this.items
      .list()
      .find((b) => b.id !== id && overlap(b.when, when) && eff.get(b.id)?.includes(key));
  }

  private changedOverrides(): void {
    this.resolved = null;
    for (const l of Array.from(this.overrideListeners)) l();
  }

  // ---------------------------------------------------------------- matching

  /** The first binding that matches `e` in this phase and whose context holds. */
  find(e: KeyboardEvent, phase: "bubble" | "capture"): KeybindingEntry | undefined {
    const eff = this.effective();
    return this.items.list().find((b) => {
      if ((b.phase ?? "bubble") !== phase || (b.when && !this.conditions[b.when](e))) return false;
      const keys = eff.get(b.id);
      if (!keys?.length) return false;
      // A key the user recorded reports the physical key, so it matches the key on any layout.
      const opts = this.overrides.has(b.id) ? { ...b, layoutIndependent: true } : b;
      return keys.some((k) => chordMatches(parseCached(k), e, opts)) && (b.available?.() ?? true);
    });
  }

  /** Any change: an entry added or removed, or an override set. */
  subscribe(listener: () => void): () => void {
    const off = this.items.subscribe(listener);
    this.overrideListeners.add(listener);
    return () => {
      off();
      this.overrideListeners.delete(listener);
    };
  }
}

const parsed = new Map<string, Chord>();
function parseCached(chord: string): Chord {
  let c = parsed.get(chord);
  if (!c) parsed.set(chord, (c = parseChord(chord)));
  return c;
}

/** The app's one keybinding registry. */
export const keybindings = new KeybindingRegistry();
