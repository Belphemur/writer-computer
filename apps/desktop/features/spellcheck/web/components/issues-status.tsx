// The footer item with the note's issue count (a spell-check icon and a number, hidden at zero)
// and its popover: one row per unique issue, each fixable everywhere at once. Reads the groups the
// linter already stored (`spell-store`), so there is no second check. Chips and surfaces use the
// app's tokens, like the editor tooltip (`editor/tooltip-theme.ts`).
import { HugeiconsIcon } from "@hugeicons/react";
import { PlusSignIcon, SpellCheckIcon, ViewOffIcon } from "@hugeicons/core-free-icons";
import { useRef, useState } from "react";
import { AnchoredPopover } from "@/components/editor-area/anchored-popover";
import { findEditorView } from "@/lib/editor-views";
import type { StatusItemProps } from "@/lib/features/types";
import { fixAll, jumpToNext } from "../editor/diagnostics";
import { handlers } from "../editor/linter";
import { countByKind, summarize, type IssueGroup } from "../lib/issue-groups";
import { anyKindEnabled, writerCheckerActive } from "../lib/settings";
import { useSpellStore } from "../lib/spell-store";

const CHIP =
  "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs leading-5 transition-colors";
const ACCENT_CHIP = `${CHIP} border-[color-mix(in_srgb,var(--accent)_30%,transparent)] bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] text-[var(--accent)] hover:bg-[color-mix(in_srgb,var(--accent)_32%,transparent)] focus-visible:bg-[color-mix(in_srgb,var(--accent)_32%,transparent)] focus-visible:outline-none`;
const QUIET_CHIP = `${CHIP} border-[var(--border-color)] text-[var(--text-muted)] hover:bg-[var(--surface-subtle)] hover:text-[var(--text-primary)] focus-visible:bg-[var(--surface-subtle)] focus-visible:outline-none`;

function IssueRow({ group, filePath }: { group: IssueGroup; filePath: string }) {
  const view = () => findEditorView(filePath);
  return (
    <li data-spellcheck-issue className="flex flex-col gap-1.5 px-2 py-1.5">
      <div className="flex items-baseline gap-2">
        <button
          type="button"
          onClick={() => {
            const v = view();
            if (v) jumpToNext(v, group);
          }}
          className="min-w-0 truncate rounded text-left text-[13px] font-semibold text-[var(--text-primary)] hover:underline focus-visible:underline focus-visible:outline-none"
        >
          {group.text}
        </button>
        {group.count > 1 && (
          <span className="text-xs text-[var(--text-muted)]">×{group.count}</span>
        )}
        <span className="ml-auto text-xs text-[var(--text-muted)]">{group.kind}</span>
      </div>
      <div className="flex flex-wrap gap-1">
        {group.replacements.map((r) => (
          <button
            key={r}
            type="button"
            className={ACCENT_CHIP}
            onClick={() => {
              const v = view();
              if (v) fixAll(v, group, r);
            }}
          >
            {r === "" ? "Remove" : r}
          </button>
        ))}
        {group.kind === "spelling" ? (
          <button type="button" className={QUIET_CHIP} onClick={() => handlers.addWord(group.text)}>
            <HugeiconsIcon icon={PlusSignIcon} size={14} aria-hidden />
            Add to dictionary
          </button>
        ) : (
          <button
            type="button"
            className={QUIET_CHIP}
            onClick={() => handlers.ignoreRule(group.ruleId)}
          >
            <HugeiconsIcon icon={ViewOffIcon} size={14} aria-hidden />
            Ignore rule
          </button>
        )}
      </div>
    </li>
  );
}

export default function IssuesStatus({ filePath }: StatusItemProps) {
  const groups = useSpellStore((s) => s.results[filePath]?.groups);
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  if (!groups?.length || !writerCheckerActive() || !anyKindEnabled()) return null;
  const total = Object.values(countByKind(groups)).reduce((a, b) => a + b, 0);
  return (
    <>
      <button
        ref={anchor}
        type="button"
        data-spellcheck-issues
        title={summarize(groups)}
        aria-label={summarize(groups)}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 rounded px-1 text-[13px] text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
      >
        <HugeiconsIcon icon={SpellCheckIcon} size={14} aria-hidden />
        {total}
      </button>
      {open && (
        <AnchoredPopover
          anchorRef={anchor}
          width={320}
          maxHeight={360}
          role="dialog"
          label="Spelling and grammar issues"
          onDismiss={() => setOpen(false)}
        >
          <ul className="flex flex-col gap-0.5 overflow-y-auto">
            {groups.map((g) => (
              <IssueRow key={g.key} group={g} filePath={filePath} />
            ))}
          </ul>
        </AnchoredPopover>
      )}
    </>
  );
}
