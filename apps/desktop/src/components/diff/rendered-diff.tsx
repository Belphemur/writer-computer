import { useState, type ReactNode } from "react";
import { foldRuns, type DiffBlock, type DiffPart, type NoteDiff } from "@/lib/text-diff";

const HEADING: Record<number, string> = {
  1: "text-[19px] font-semibold",
  2: "text-[17px] font-semibold",
  3: "text-[15px] font-semibold",
};

/** Insertions are underlined in the success colour, deletions struck in the danger colour. */
function Parts({ parts }: { parts: readonly DiffPart[] }) {
  return (
    <>
      {parts.map((p, i) =>
        p.op === "ins" ? (
          <ins
            key={i}
            data-diff-mark="ins"
            className="bg-[var(--success-soft)] text-[var(--success)] underline decoration-[var(--success)]"
          >
            {p.text}
          </ins>
        ) : p.op === "del" ? (
          <del
            key={i}
            data-diff-mark="del"
            className="bg-[var(--danger-soft)] text-[var(--danger)] line-through decoration-[var(--danger)]"
          >
            {p.text}
          </del>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

function Block({ block }: { block: DiffBlock }) {
  const content = <Parts parts={block.parts} />;
  const common = { "data-diff-block": block.change, "data-diff-style": block.style } as const;
  switch (block.style) {
    case "heading":
      return (
        <div
          {...common}
          role="heading"
          aria-level={block.level}
          className={`mt-2 text-text-primary ${HEADING[block.level] ?? "text-[14px] font-semibold"}`}
        >
          {content}
        </div>
      );
    case "list-item":
      return (
        <div
          {...common}
          className="flex gap-2 text-text-primary"
          style={{ paddingLeft: `${block.level * 16}px` }}
        >
          <span aria-hidden="true" className="text-text-muted">
            •
          </span>
          <span className="min-w-0 flex-1">{content}</span>
        </div>
      );
    case "quote":
      return (
        <blockquote {...common} className="border-l-2 border-border pl-3 text-text-secondary">
          {content}
        </blockquote>
      );
    case "code":
      return (
        <pre
          {...common}
          className="overflow-auto rounded-md bg-[var(--surface-subtle)] px-2 py-1 font-[var(--mono-font)] text-[12px] whitespace-pre-wrap"
        >
          {content}
        </pre>
      );
    case "rule":
      return <hr {...common} className="border-border" />;
    default:
      return (
        <p {...common} className="text-text-primary">
          {content}
        </p>
      );
  }
}

function PropertyRows({ rows }: { rows: NoteDiff["front"] }) {
  if (rows.length === 0) return null;
  return (
    <dl
      data-diff-properties
      className="mb-3 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 rounded-md border border-border px-3 py-2 text-[12.5px]"
    >
      {rows.map((p) => (
        <div key={p.name} data-diff-property={p.name} className="contents">
          <dt className="text-text-muted">{p.name}</dt>
          <dd className="min-w-0 break-words">
            {p.before !== null && (
              <del className="bg-[var(--danger-soft)] text-[var(--danger)] line-through">
                {p.before}
              </del>
            )}
            {p.before !== null && p.after !== null && (
              <span aria-hidden="true" className="px-1 text-text-muted">
                →
              </span>
            )}
            {p.after !== null && (
              <ins className="bg-[var(--success-soft)] text-[var(--success)] underline">
                {p.after}
              </ins>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** The rendered view of a note diff: front matter as property rows, then the body as the editor
 *  shows it (headings, lists, quotes, code), with insertions and deletions marked in the text and
 *  unchanged blocks folded behind "Show N unchanged". */
export function RenderedDiff({
  note,
  label,
  className = "",
}: {
  note: NoteDiff;
  label: string;
  className?: string;
}) {
  const [opened, setOpened] = useState<ReadonlySet<number>>(new Set());
  const segments = foldRuns(note.blocks, (b) => b.change === "same", 1);
  const body: ReactNode[] = [];
  segments.forEach((seg, i) => {
    if (seg.kind === "gap" && !opened.has(i)) {
      body.push(
        <button
          key={`gap-${i}`}
          type="button"
          onClick={() => setOpened(new Set(opened).add(i))}
          className="block w-full rounded-md bg-[var(--surface-subtle)] px-2 py-0.5 text-left text-[11px] text-text-muted hover:text-text-primary"
        >
          Show {seg.rows.length} unchanged
        </button>,
      );
      return;
    }
    seg.rows.forEach((b, j) => body.push(<Block key={`${i}-${j}`} block={b} />));
  });
  const empty = note.front.length === 0 && note.blocks.every((b) => b.change === "same");
  return (
    <div
      role="group"
      aria-label={label}
      data-diff-rendered
      className={`space-y-2 text-[13.5px] leading-relaxed ${className}`}
    >
      <PropertyRows rows={note.front} />
      {empty ? <p className="text-[11.5px] text-text-muted">No changes</p> : body}
    </div>
  );
}
