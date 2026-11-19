import type { KindChoice } from "./kind-choices";

/**
 * The kind filter above palette results, one chip per choice (`kindChoices`: All, the registry's
 * kinds by label, Commands in quick open). One selection at a time; `null` is All. Not drawn
 * without choices.
 */
export function KindChips({
  choices,
  selected,
  onSelect,
}: {
  choices: KindChoice[];
  selected: string | null;
  onSelect: (kind: string | null) => void;
}) {
  if (choices.length === 0) return null;
  const chip = (id: string | null, label: string) => (
    <button
      key={id ?? "all"}
      type="button"
      tabIndex={-1}
      aria-pressed={selected === id}
      data-testid={`kind-chip-${id ?? "all"}`}
      onClick={() => onSelect(id)}
      className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs transition-colors ${
        selected === id
          ? "bg-[var(--surface-selected)] font-medium text-[var(--text-primary)]"
          : "text-text-muted hover:bg-[var(--item-hover-bg)]"
      }`}
    >
      {label}
    </button>
  );
  return (
    <div
      role="group"
      aria-label="Filter by kind"
      className="flex gap-1 overflow-x-auto border-b border-[var(--line-subtle)] px-3 py-2"
    >
      {choices.map((c) => chip(c.id, c.label))}
    </div>
  );
}
