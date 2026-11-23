import { useBodyTags } from "@/hooks/use-body-tags";
import { linkHandlers, tagLinkTarget } from "@/lib/link-activation";

interface BodyTagsProps {
  filePath: string;
  /** The tags the front matter already has (they are not repeated). */
  written: readonly string[];
  /** A row of its own, for a note whose front matter has no tags row; else just the chips. */
  row?: boolean;
}

/** The tags written in the note's body: read-only chips, quieter than the front matter's (they
 *  are edited in the text), after the tags row's own chips. A click searches the tag, like the
 *  pill in the editor. This component alone follows the typing (`useBodyTags`), so a keystroke in
 *  the body re-renders these chips and not the panel. */
export function BodyTags({ filePath, written, row = false }: BodyTagsProps) {
  const tags = useBodyTags(filePath, written);
  if (tags.length === 0) return null;
  const chips = tags.map((tag) => (
    <button
      key={tag}
      type="button"
      title="In the note"
      {...linkHandlers(tagLinkTarget(tag))}
      className="inline-flex max-w-full items-center rounded-full border border-dashed border-[var(--surface-subtle)] px-2 py-0.5 text-[12px] leading-[1.3] text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-border)]"
    >
      <span className="min-w-0 break-words">#{tag}</span>
    </button>
  ));
  if (!row) return chips;
  return (
    <div className="flex items-baseline gap-4 py-1">
      <span className="-mr-2.5 w-5 shrink-0" aria-hidden="true" />
      <span className="w-[clamp(5rem,28%,10rem)] shrink-0 text-[13px] leading-[1.4] text-[var(--text-muted)]">
        tags
      </span>
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1">{chips}</span>
    </div>
  );
}
