/**
 * A project's icon and color (spec 4.8). Light on purpose: the file-tree badge reaches it from the
 * feature's startup graph, so it must never import the Hugeicons set. The set is its own chunk
 * (`lib/icon-picker/icon-shards.ts`, 26 chunks by first letter, core). Drawing an icon loads its
 * letter's shard, the picker loads them all; until then, and for a name without a file, the
 * default icon.
 */
import { SparklesIcon } from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import projectColors from "@shared/project-colors.json";
import { useHugeicon } from "@/lib/icon-picker/icon-set";
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
  return isProjectColor(color) ? `var(--project-color-${color})` : "var(--accent)";
}

/** Whether `color` names one of `shared/project-colors.json`. */
export function isProjectColor(color: string | null | undefined): color is string {
  return !!color && PROJECT_COLORS.includes(color);
}

export const appearanceOf = (p: Pick<ProjectDetail, "icon" | "color"> | undefined) =>
  p ? { icon: p.icon, color: p.color } : NO_APPEARANCE;

/** The icon for a stored name: the default until its file has loaded and for a name without one. */
export function useProjectIcon(name: string | null | undefined): IconSvgElement {
  return useHugeicon(name) ?? DEFAULT_PROJECT_ICON;
}
