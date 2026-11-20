// Settings > Lint: the fix-on-save switch and one switch per rule, the safe rules (the ones saving
// fixes) first. The two lists behind the switches are the difference from the defaults
// (`lib/settings.ts`). Text stays terse: a rule's name and its id.
import { BooleanControl } from "@/components/settings-panel/setting-control";
import { SettingRows } from "@/components/settings-panel/setting-rows";
import { useAllSettings } from "@/hooks/use-settings";
import { FEATURE_SETTINGS, type SettingDef } from "@/lib/settings-schema";
import { enabledRules, KEYS, RULES, setRule, type RuleInfo } from "../lib/settings";

const CARD =
  "overflow-hidden rounded-2xl border border-[var(--line-subtler)] bg-[var(--surface-card)]";
const ROW = "flex items-center justify-between gap-4 px-4 py-3 text-[13px]";
const HEADING = "px-1 pb-2 pt-1 text-[13px] font-medium text-[var(--text-primary)]";
const MUTED = "text-[var(--text-muted)]";

function RuleRows({
  title,
  rules,
  on,
}: {
  title: string;
  rules: RuleInfo[];
  on: ReadonlySet<string>;
}) {
  return (
    <section aria-label={title}>
      <h3 className={HEADING}>{title}</h3>
      <div className={CARD}>
        {rules.map((r, i) => (
          <div
            key={r.id}
            data-lint-rule={r.id}
            className={`${ROW} ${i === 0 ? "" : "border-t border-[var(--line-subtler)]"}`}
          >
            <span>
              {r.name} <span className={MUTED}>{r.id}</span>
              {!r.fixable && <span className={MUTED}>, no fix</span>}
            </span>
            <BooleanControl
              value={on.has(r.id)}
              onChange={(next) => void setRule(r.id, next)}
              label={`${r.name} (${r.id})`}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

export function LintSection() {
  // re-render when the lists change: the rows read them through the store
  const settings = useAllSettings();
  const on = enabledRules(settings);
  const defs = ((FEATURE_SETTINGS.lint ?? []) as readonly SettingDef[]).filter(
    (d) => d.key === KEYS.fixOnSave,
  );
  return (
    <div className="space-y-6">
      <SettingRows defs={defs} />
      <RuleRows title="Fixed on save" rules={RULES.filter((r) => r.safe)} on={on} />
      <RuleRows title="Other rules" rules={RULES.filter((r) => !r.safe)} on={on} />
    </div>
  );
}
