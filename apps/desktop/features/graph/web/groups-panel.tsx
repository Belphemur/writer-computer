// The Groups panel (spec 3.4): ordered color rules (a query and a color each, first match wins,
// reorderable) and Group by (none, tags, folder or any frontmatter key, with the nested level).
import { useEffect, useState } from "react";
import type { ColorRule, GroupBy, SurfaceId } from "./config";
import { vaultPropertyNames } from "./ipc";
import { GROUP_PALETTE } from "./theme";
import { useGraphConfig } from "./store";

const INPUT =
  "h-7 min-w-0 flex-1 rounded-md border border-transparent bg-[var(--surface-input)] px-2 text-[12px] text-[var(--text-secondary)] outline-none focus:border-[var(--focus-border)]";
const BTN =
  "rounded-md px-1.5 py-0.5 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--item-hover-bg)] disabled:opacity-30";

/** Moves item `from` to index `to` (clamped); the list is returned as is for a no-op. */
export function moveRule<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  const target = Math.max(0, Math.min(next.length - 1, to));
  if (from === target || from < 0 || from >= next.length) return next;
  const [item] = next.splice(from, 1);
  next.splice(target, 0, item!);
  return next;
}

export function GroupsPanel({
  surface,
  rules,
  groupBy,
}: {
  surface: SurfaceId;
  rules: readonly ColorRule[];
  groupBy: GroupBy;
}) {
  const update = useGraphConfig((s) => s.update);
  const [properties, setProperties] = useState<string[]>([]);
  useEffect(() => {
    let stale = false;
    vaultPropertyNames().then(
      (names) => !stale && setProperties(names),
      () => undefined,
    );
    return () => {
      stale = true;
    };
  }, []);
  const setRules = (next: ColorRule[]) => update(surface, (s) => ({ ...s, rules: next }));
  const setGroupBy = (patch: Partial<GroupBy>) =>
    update(surface, (s) => ({ ...s, groupBy: { ...s.groupBy, ...patch } }));
  const patchRule = (i: number, patch: Partial<ColorRule>) =>
    setRules(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const addRule = () => {
    const id = `rule-${Date.now().toString(36)}`;
    setRules([
      ...rules,
      { id, query: "", color: GROUP_PALETTE[rules.length % GROUP_PALETTE.length]! },
    ]);
  };
  const options = ["tags", "folder", ...properties.filter((p) => p !== "tags")];
  const nested = groupBy.property === "tags" || groupBy.property === "folder";
  return (
    <div className="flex flex-col gap-2 p-3" data-testid="graph-groups">
      <div className="text-[11px] font-medium text-[var(--text-muted)]">
        Color rules (first match wins)
      </div>
      {rules.map((r, i) => (
        <div key={r.id} className="flex items-center gap-1" data-testid="graph-rule">
          <input
            type="color"
            aria-label="Rule color"
            value={/^#[0-9a-f]{6}$/i.test(r.color) ? r.color : "#5b8def"}
            onChange={(e) => patchRule(i, { color: e.target.value })}
          />
          <input
            className={INPUT}
            aria-label="Rule query"
            value={r.query}
            placeholder="tag:person  path:projects/"
            onChange={(e) => patchRule(i, { query: e.target.value })}
          />
          <button
            type="button"
            className={BTN}
            aria-label="Move rule up"
            disabled={i === 0}
            onClick={() => setRules(moveRule(rules, i, i - 1))}
          >
            Up
          </button>
          <button
            type="button"
            className={BTN}
            aria-label="Move rule down"
            disabled={i === rules.length - 1}
            onClick={() => setRules(moveRule(rules, i, i + 1))}
          >
            Down
          </button>
          <button
            type="button"
            className={BTN}
            aria-label="Remove rule"
            onClick={() => setRules(rules.filter((_, j) => j !== i))}
          >
            Remove
          </button>
        </div>
      ))}
      <button type="button" className={`${BTN} self-start`} onClick={addRule}>
        New rule
      </button>
      <div
        className="mt-2 text-[11px] font-medium text-[var(--text-muted)]"
        id={`gg-by-${surface}`}
      >
        Group by
      </div>
      <select
        aria-labelledby={`gg-by-${surface}`}
        className={INPUT}
        value={groupBy.property ?? ""}
        onChange={(e) => setGroupBy({ property: e.target.value || null })}
      >
        <option value="">None</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
      {nested && (
        <label className="flex items-center gap-2 text-[12px] text-[var(--text-secondary)]">
          Nested level
          <select
            className={`${INPUT} w-16 flex-none`}
            value={groupBy.nestedLevel}
            onChange={(e) => setGroupBy({ nestedLevel: Number(e.target.value) as 1 | 2 | 3 })}
          >
            <option value={1}>1</option>
            <option value={2}>2</option>
            <option value={3}>3</option>
          </select>
        </label>
      )}
    </div>
  );
}
