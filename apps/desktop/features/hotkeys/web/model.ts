// The Hotkeys page as data: the rows and their groups from the registry, the two searches (by
// name, by pressed key) and the Obsidian import. Pure, so the page stays a thin view and the rules
// are tested without a DOM (SPECs/hotkeys-spec.md).
import { featureOfOwner } from "@/lib/features/id";
import { FEATURE_MANIFESTS } from "@/lib/features/manifests";
import { obsidianToChord } from "@/lib/keybindings/obsidian";
import type { KeybindingEntry, KeybindingRegistry } from "@/lib/keybindings/registry";

export interface HotkeyRow {
  id: string;
  label: string;
  group: string;
  /** The keys in force (normalized chords), the first one is the main one. */
  chords: readonly string[];
  modified: boolean;
  rebindable: boolean;
}

export interface HotkeyGroup {
  name: string;
  rows: HotkeyRow[];
}

export const CORE_GROUP = "Writer";

/** The group an entry is listed under: the core's own, a feature's name, or the plugin's name. */
export function groupOf(entry: Pick<KeybindingEntry, "owner" | "group">): string {
  if (entry.group) return entry.group;
  if (entry.owner === "core") return CORE_GROUP;
  const feature = featureOfOwner(entry.owner);
  return FEATURE_MANIFESTS.find((m) => m.id === feature)?.name ?? entry.owner;
}

/** Writer first, then the features by name, then the plugins by name. */
const rank = (name: string) => (name === CORE_GROUP ? 0 : name.endsWith("(plugin)") ? 2 : 1);

export function buildGroups(
  registry: KeybindingRegistry,
  /** The palette's name for a command, when it has one. */
  labelOf: (id: string) => string | undefined,
): HotkeyGroup[] {
  const groups = new Map<string, HotkeyRow[]>();
  for (const e of registry.list()) {
    const name = groupOf(e);
    const row: HotkeyRow = {
      id: e.id,
      label: labelOf(e.id) ?? e.description,
      group: name,
      chords: registry.effectiveKeys(e.id),
      modified: registry.isModified(e.id),
      rebindable: e.rebindable !== false,
    };
    groups.set(name, [...(groups.get(name) ?? []), row]);
  }
  return [...groups.entries()]
    .map(([name, rows]) => ({
      name,
      rows: rows.sort((a, b) => a.label.localeCompare(b.label)),
    }))
    .sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}

/** What the search box holds: typed words, or a key combination that was pressed in it. */
export type Query = { kind: "text"; text: string } | { kind: "chord"; chord: string };

export function filterGroups(groups: readonly HotkeyGroup[], query: Query): HotkeyGroup[] {
  const text = query.kind === "text" ? query.text.trim().toLowerCase() : "";
  if (query.kind === "text" && !text) return [...groups];
  const keep = (r: HotkeyRow) =>
    query.kind === "chord"
      ? r.chords.includes(query.chord)
      : r.label.toLowerCase().includes(text) || r.group.toLowerCase().includes(text);
  return groups.map((g) => ({ ...g, rows: g.rows.filter(keep) })).filter((g) => g.rows.length > 0);
}

export interface ImportResult {
  /** command id -> chords for the current OS, to write as overrides. */
  keys: Record<string, string[]>;
  imported: number;
  skipped: number;
}

/**
 * Maps the text of `.obsidian/hotkeys.json` (`{ "<command id>": [{ modifiers, key }] }`) to
 * overrides. A command Writer does not have (an Obsidian core command, a plugin that is not
 * loaded) is skipped, and so is one whose keys all fail to map or cannot be bound here; one with
 * some usable keys is imported with those. An empty list is imported as "no keys".
 */
export function mapObsidianHotkeys(text: string, registry: KeybindingRegistry): ImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("hotkeys.json in .obsidian is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("hotkeys.json in .obsidian is not an object");
  const result: ImportResult = { keys: {}, imported: 0, skipped: 0 };
  for (const [id, list] of Object.entries(parsed)) {
    if (!registry.get(id) || registry.get(id)?.rebindable === false || !Array.isArray(list)) {
      result.skipped++;
      continue;
    }
    const chords = list
      .flatMap((h) => obsidianToChord(h) ?? [])
      .filter((c) => registry.refusal(c) === undefined);
    if (list.length > 0 && chords.length === 0) {
      result.skipped++;
      continue;
    }
    result.keys[id] = [...new Set(chords)];
    result.imported++;
  }
  return result;
}
