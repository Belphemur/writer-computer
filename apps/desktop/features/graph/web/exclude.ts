// The Exclude list of the Filters (spec 3.3): one list holding folders and name patterns, and the
// one-click presets detected from the notes of the slice (generated notes such as `agent__*`,
// daily and weekly notes by their date-like names, recaps, quiet folders). Pure.

/** The part of a note the exclude rules read. */
export interface Excludable {
  folder: string;
  /** File name; a trailing `.md` is ignored. */
  name: string;
}

export const inFolder = (folder: string, root: string) =>
  folder === root || folder.startsWith(`${root.replace(/\/+$/, "")}/`);

/** An entry with `*` (any text) or `#` (a digit) is a name pattern, anything else a folder. */
export const isPattern = (entry: string) => /[*#]/.test(entry);

const patterns = new Map<string, RegExp>();
function compile(entry: string): RegExp {
  let re = patterns.get(entry);
  if (!re) {
    const body = [...entry]
      .map((c) => (c === "*" ? ".*" : c === "#" ? "\\d" : c.replace(/[.+?^${}()|[\]\\]/g, "\\$&")))
      .join("");
    re = new RegExp(`^${body}$`, "i");
    patterns.set(entry, re);
  }
  return re;
}

/** Whether `entry` (a folder or a name pattern) excludes the note. */
export function excludes(entry: string, n: Excludable): boolean {
  return isPattern(entry)
    ? compile(entry).test(n.name.replace(/\.md$/i, ""))
    : inFolder(n.folder, entry);
}

export interface ExcludePreset {
  /** What goes in the list. */
  entry: string;
  label: string;
  /** Notes of the slice it removes. */
  count: number;
}

const MIN_PREFIX = 5;
const MIN_NAMED = 5;
const MIN_FOLDER = 3;

const NAMED: readonly { entry: string; label: string }[] = [
  { entry: "####-##-##*", label: "Daily notes" },
  { entry: "####-W##*", label: "Weekly notes" },
  { entry: "*recap*", label: "Recaps" },
];
const QUIET_FOLDER = /^(daily|weekly|recaps?|journal|archive|templates?)$/i;

/** Presets worth offering for `notes`, the biggest first. */
export function detectPresets(notes: readonly Excludable[]): ExcludePreset[] {
  const prefixes = new Map<string, number>();
  const folders = new Map<string, number>();
  for (const n of notes) {
    const m = /^([A-Za-z0-9-]+)__/.exec(n.name);
    if (m) prefixes.set(m[1]!, (prefixes.get(m[1]!) ?? 0) + 1);
    const leaf = n.folder.split("/").pop() ?? "";
    if (n.folder && QUIET_FOLDER.test(leaf))
      folders.set(n.folder, (folders.get(n.folder) ?? 0) + 1);
  }
  const out: ExcludePreset[] = [];
  for (const [prefix, count] of prefixes) {
    if (count >= MIN_PREFIX) out.push({ entry: `${prefix}__*`, label: `${prefix}__*`, count });
  }
  for (const p of NAMED) {
    const count = notes.filter((n) => excludes(p.entry, n)).length;
    if (count >= MIN_NAMED) out.push({ ...p, count });
  }
  for (const [folder, count] of folders) {
    if (count >= MIN_FOLDER) out.push({ entry: folder, label: `${folder}/`, count });
  }
  return out.sort((a, b) => b.count - a.count || a.entry.localeCompare(b.entry));
}

/** The list with `entry` switched on or off. */
export const toggleEntry = (list: readonly string[], entry: string): string[] =>
  list.includes(entry) ? list.filter((e) => e !== entry) : [...list, entry];
