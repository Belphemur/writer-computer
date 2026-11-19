import type { SearchKind } from "@/lib/content-search";

/**
 * The kind filter above palette results: All, then one chip per listed kind by its label (the
 * registry's, `search_kinds`). One selection at a time; `null` is All. Not drawn while the vault
 * lists a single kind: there is nothing to narrow.
 */
export function KindChips({
  kinds,
  selected,
  onSelect,
}: {
  kinds: SearchKind[];
  selected: string | null;
  onSelect: (kind: string | null) => void;
}) {
  if (kinds.length < 2) return null;
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
      {chip(null, "All")}
      {kinds.map((k) => chip(k.id, k.label))}
    </div>
  );
}
