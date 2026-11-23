import { TextDiffView } from "@/components/diff/text-diff-view";
import type { TextDiffData } from "@/lib/text-diff";
import type { FileChangeSummary } from "@features/agent/web/lib/events";
import { middleTruncate, originNote } from "@features/agent/web/lib/diff-rows";
import { vaultLinkHandlers } from "./agent-links";

const MINUS = "−";

export function Counts({ added, removed }: { added: number; removed: number }) {
  return (
    <span
      className="shrink-0 font-[var(--mono-font)] text-[11.5px]"
      aria-label={`${added} added, ${removed} removed`}
    >
      <span className="text-[var(--success)]">+{added}</span>{" "}
      <span className="text-[var(--danger)]">
        {MINUS}
        {removed}
      </span>
    </span>
  );
}

/** "by command" / "before unknown": the marker of a file that is not an ordinary edit; nothing
 *  for one. */
export function OriginMarker({ f }: { f: FileChangeSummary }) {
  const note = originNote(f);
  if (!note) return null;
  return (
    <span
      data-agent-change-origin={f.origin}
      title={note.title}
      className="shrink-0 rounded-full bg-[var(--surface-subtle)] px-1.5 text-[10.5px] leading-4 text-text-muted"
    >
      {note.marker}
    </span>
  );
}

export function FileName({ f }: { f: FileChangeSummary }) {
  const shown = middleTruncate(f.path);
  const text = f.oldPath ? `${middleTruncate(f.oldPath, 28)} → ${shown}` : shown;
  const cls = "min-w-0 text-left font-[var(--mono-font)] text-[12px] break-all";
  if (f.status === "deleted")
    return (
      <span className={`${cls} text-text-muted line-through`} title={f.path}>
        {text}
      </span>
    );
  return (
    <button
      type="button"
      title={f.path}
      aria-label={`Open ${f.path}`}
      {...vaultLinkHandlers(f.path)}
      className={`${cls} text-text-primary underline-offset-2 hover:underline`}
    >
      {text}
    </button>
  );
}

export function FileDiffBody({
  f,
  d,
  status,
  error,
}: {
  f: FileChangeSummary;
  d: TextDiffData | undefined;
  status: "loading" | "ready" | "unavailable" | "error" | undefined;
  error: string | null | undefined;
}) {
  if (status === "unavailable")
    return <p className="text-[11.5px] text-text-muted">Diff no longer available after restart</p>;
  if (status === "error")
    return (
      <p role="alert" className="text-[11.5px] text-[var(--danger)]">
        Could not load the diff: {error ?? "unknown error"}
      </p>
    );
  if (!d) return <p className="text-[11.5px] text-text-muted">Loading diff…</p>;
  const note = originNote(f);
  if (note?.body) return <p className="text-[11.5px] text-text-muted">{note.body}</p>;
  if (f.noDiff)
    return (
      <p className="text-[11.5px] text-text-muted">
        Binary or very large file: listed without a diff
      </p>
    );
  if (f.status === "renamed")
    return <p className="text-[11.5px] text-text-muted">Renamed from {f.oldPath}, content equal</p>;
  return <TextDiffView diff={d} label={`Diff of ${f.path}`} />;
}
