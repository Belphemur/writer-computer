/**
 * The Hugeicons free set (the one icon picker's, `components/icon-picker`) in 26 chunks by first letter (`icon-shards/<L>.ts`, each an eager glob of
 * that letter's per-icon files). Drawing an icon loads its letter (about 0.1 to 1 MB), the picker
 * loads them all (the full, searchable set). A chunk per icon would be ~6,000 files in the app
 * bundle and a 4,000-entry preload map in the entry chunk; one chunk for everything is 6 MB for a
 * single icon. Names are the file names, so a name offered by the picker can always be drawn
 * (aliases such as `ArrowDownAzIcon` have no file).
 */
import type { IconSvgElement } from "@hugeicons/react";

export type IconSet = Record<string, IconSvgElement>;

const SHARDS = import.meta.glob<Record<string, IconSvgElement>>("./icon-shards/*.ts", {
  import: "default",
});

const letterOf = (path: string) => path.slice(path.lastIndexOf("/") + 1, -3);
const LOADERS = new Map(Object.entries(SHARDS).map(([path, load]) => [letterOf(path), load]));

export const SHARD_LETTERS: readonly string[] = [...LOADERS.keys()].sort();

/** The shard a stored icon name lives in, or null for a name that cannot be one. */
export const shardOf = (name: string): string | null =>
  LOADERS.has(name.charAt(0)) ? name.charAt(0) : null;

/** One letter's icons by name (the shard's keys are file paths). */
export async function loadShard(letter: string): Promise<IconSet> {
  const byPath = (await LOADERS.get(letter)?.()) ?? {};
  return Object.fromEntries(
    Object.entries(byPath).map(([path, icon]) => [path.slice(path.lastIndexOf("/") + 1, -3), icon]),
  );
}
