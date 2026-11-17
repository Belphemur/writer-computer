/**
 * A project's icon and color (spec 4.8). Light on purpose: the file-tree badge reaches it from the
 * feature's startup graph, so it must never import the Hugeicons set. The set is its own chunk
 * (`project-icon-shards.ts`, 26 chunks by first letter). Drawing an icon loads its letter's
 * shard, the picker loads them all; until then, and for a name without a file, the default icon.
 */
import { useEffect, useSyncExternalStore } from "react";
import { SparklesIcon } from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import projectColors from "@shared/project-colors.json";
import {
  SHARD_LETTERS,
  loadShard,
  shardOf,
  type IconSet,
} from "@features/agent/web/lib/project-icon-shards";
import type { ProjectDetail } from "@features/agent/web/lib/project-client";

export const PROJECT_COLORS: readonly string[] = projectColors.colors.map((c) => c.name);
export const DEFAULT_PROJECT_ICON: IconSvgElement = SparklesIcon;

export interface ProjectAppearance {
  icon: string | null;
  color: string | null;
}

export const NO_APPEARANCE: ProjectAppearance = { icon: null, color: null };

/** The CSS color of a project color name; the current accent for none or an unknown name. */
export function projectColorVar(color: string | null | undefined): string {
  return color && PROJECT_COLORS.includes(color)
    ? `var(--project-color-${color})`
    : "var(--accent)";
}

export const appearanceOf = (p: Pick<ProjectDetail, "icon" | "color"> | undefined) =>
  p ? { icon: p.icon, color: p.color } : NO_APPEARANCE;

// Icons loaded so far by name, shared by every ProjectIcon. Drawing one loads its letter's shard
// (spec 4.8) and caches the whole shard; the picker loads every shard.
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
export function loadProjectIconSet(): Promise<IconSet> {
  loadingSet ??= Promise.all(SHARD_LETTERS.map(loadLetter)).then(() => Object.fromEntries(cache));
  loadingSet.catch(() => (loadingSet = null));
  return loadingSet;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The icon for a stored name: the default until its file has loaded and for a name without one. */
export function useProjectIcon(name: string | null | undefined): IconSvgElement {
  useSyncExternalStore(
    subscribe,
    () => version,
    () => 0,
  );
  useEffect(() => {
    const letter = name ? shardOf(name) : null;
    if (letter && !cache.has(name!)) void loadLetter(letter).catch(() => {});
  }, [name]);
  return (name && cache.get(name)) || DEFAULT_PROJECT_ICON;
}

/** Test seam: forget the loaded set. */
export function resetProjectIconSetForTests(): void {
  loadingSet = null;
  cache.clear();
  shards.clear();
}
