/**
 * The loaded Hugeicons, shared by everything that draws a picked icon (project icons, enum value
 * icons). Light on purpose: it never imports the Hugeicons set, which is its own chunks
 * (`icon-shards.ts`, 26 chunks by first letter). Drawing an icon loads its letter's shard, the
 * picker loads them all; until then, and for a name without a file, there is no icon.
 */
import { useEffect, useSyncExternalStore } from "react";
import type { IconSvgElement } from "@hugeicons/react";
import { SHARD_LETTERS, loadShard, shardOf, type IconSet } from "./icon-shards";

let loadingSet: Promise<IconSet> | null = null;
const cache = new Map<string, IconSvgElement>();
const shards = new Map<string, Promise<void>>();
let version = 0;
const listeners = new Set<() => void>();

function changed() {
  version++;
  for (const l of listeners) l();
}

function loadLetter(letter: string): Promise<void> {
  let p = shards.get(letter);
  if (!p) {
    p = loadShard(letter).then((icons) => {
      for (const [name, icon] of Object.entries(icons)) cache.set(name, icon);
      changed();
    });
    // A failed load may be retried by the next draw.
    p.catch(() => shards.delete(letter));
    shards.set(letter, p);
  }
  return p;
}

/** Load every shard once: the picker's search and grid (about 6 MB, only when it opens). */
export function loadIconSet(): Promise<IconSet> {
  loadingSet ??= Promise.all(SHARD_LETTERS.map(loadLetter)).then(() => Object.fromEntries(cache));
  loadingSet.catch(() => (loadingSet = null));
  return loadingSet;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The icon of a Hugeicons export name, or null until its shard has loaded and for a name
 *  without a file. */
export function useHugeicon(name: string | null | undefined): IconSvgElement | null {
  useSyncExternalStore(
    subscribe,
    () => version,
    () => 0,
  );
  useEffect(() => {
    const letter = name ? shardOf(name) : null;
    if (letter && !cache.has(name!)) void loadLetter(letter).catch(() => {});
  }, [name]);
  return (name && cache.get(name)) || null;
}

/** Test seam: forget the loaded set. */
export function resetIconSetForTests(): void {
  loadingSet = null;
  cache.clear();
  shards.clear();
}
