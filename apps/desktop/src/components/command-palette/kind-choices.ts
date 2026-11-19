import type { KeyboardEvent } from "react";
import type { SearchKind } from "@/lib/content-search";

/**
 * The pseudo-kind of the Commands chip in the file palette: commands only, no files. It is never
 * sent to a search and must not equal a registry kind id (a test reads the Rust registry).
 */
export const COMMANDS_KIND = "commands";

/** One chip: `id` null is All. */
export interface KindChoice {
  id: string | null;
  label: string;
}

/**
 * The one chip list, in order: All, one per registry kind, then Commands when `withCommands`.
 * Empty while fewer than two things narrow the list (the kinds plus Commands), so the chips and Tab
 * cycling agree: one listed kind alone is not drawn, one kind with Commands is.
 */
export function kindChoices(kinds: SearchKind[], withCommands = false): KindChoice[] {
  const narrowing: KindChoice[] = [
    ...kinds.map((k) => ({ id: k.id, label: k.label })),
    ...(withCommands ? [{ id: COMMANDS_KIND, label: "Commands" }] : []),
  ];
  return narrowing.length < 2 ? [] : [{ id: null, label: "All" }, ...narrowing];
}

/** The choice after (`step` 1) or before (`step` -1) `selected`, wrapping. A stale id counts as All. */
export function stepKind(
  choices: KindChoice[],
  selected: string | null,
  step: 1 | -1,
): string | null {
  if (choices.length === 0) return selected;
  const at = Math.max(
    0,
    choices.findIndex((c) => c.id === selected),
  );
  return choices[(at + step + choices.length) % choices.length].id;
}

/**
 * Tab / Shift+Tab on a palette: select the next / previous chip, focus stays in the input.
 * Does nothing (the key is left alone) when no chips are drawn.
 */
export function cycleKindOnTab(
  e: KeyboardEvent,
  choices: KindChoice[],
  selected: string | null,
  select: (kind: string | null) => void,
) {
  if (e.key !== "Tab" || e.ctrlKey || e.metaKey || e.altKey || choices.length === 0) return;
  e.preventDefault();
  select(stepKind(choices, selected, e.shiftKey ? -1 : 1));
}
