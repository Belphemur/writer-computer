import { useState } from "react";
import type { TextDiffData } from "@/lib/text-diff";
import { LineDiff } from "./line-diff";
import { RenderedDiff } from "./rendered-diff";

const TOGGLE =
  "rounded-md border border-border px-2 py-0.5 text-[11.5px] text-text-secondary hover:bg-[var(--item-hover-bg)] hover:text-text-primary";

/**
 * The one diff component of Writer: the agent's Changes card and the Git history show a text
 * change through it (spec `SPECs/git-sync-spec.md` "Diff"). A note is shown rendered, with marks
 * in the text and its front matter as property rows, and a "Source" toggle switches to the line
 * diff; a version whose only change is formatting says so and starts on the source. Any other
 * text file is the line diff alone.
 */
export function TextDiffView({
  diff,
  label,
  className,
}: {
  diff: TextDiffData;
  label: string;
  /** Sizing of the box around the view (a page that scrolls it itself passes its own). */
  className?: string;
}) {
  const rendered = diff.rendered ?? null;
  const [source, setSource] = useState(diff.formattingOnly === true);
  if (!rendered) {
    return (
      <LineDiff rows={diff.rows} truncated={diff.truncated} label={label} className={className} />
    );
  }
  return (
    <div data-text-diff className="space-y-1.5">
      <div className="flex items-center gap-2">
        {diff.formattingOnly && (
          <span
            data-diff-formatting-only
            className="rounded-full bg-[var(--surface-subtle)] px-1.5 text-[10.5px] leading-4 text-text-muted"
          >
            Formatting only
          </span>
        )}
        <button
          type="button"
          aria-pressed={source}
          onClick={() => setSource((v) => !v)}
          className={`${TOGGLE} ml-auto`}
        >
          Source
        </button>
      </div>
      {source ? (
        <LineDiff rows={diff.rows} truncated={diff.truncated} label={label} className={className} />
      ) : (
        <RenderedDiff note={rendered} label={label} className={className} />
      )}
    </div>
  );
}
