import { useEffect, useRef, useState } from "react";
import { MODAL_PANEL, ModalShell } from "@/components/modal-shell";
import {
  applyNoteTitle,
  readNoteTitleOverride,
  retitleNote,
  type RetitleResult,
} from "@/lib/note-title-actions";
import { getFileName } from "@/lib/paths";
import { closeNoteTitleDialog, useNoteTitleDialogStore } from "@/stores/note-title-dialog-store";

const FIELD =
  "w-full rounded-lg border border-transparent bg-[var(--surface-input)] px-3 text-[13px] text-[var(--text-secondary)] outline-none focus:border-[var(--focus-border)]";
const BUTTON =
  "h-8 rounded-lg px-3 text-[13px] text-[var(--text-secondary)] hover:bg-[var(--surface-subtle)] disabled:opacity-50";
const PRIMARY =
  "h-8 rounded-lg bg-[var(--accent)] px-3 text-[13px] font-medium text-white disabled:opacity-50";

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Something went wrong.";
}

/**
 * "Set display title": the frontmatter `title` property, an explicit override of the name shown
 * for a note. It never renames the file or changes a link target; links that show the old title
 * as their alias can follow (`relocate::retitle`). Rendered once from the dialog store.
 */
export function NoteTitleDialog() {
  const path = useNoteTitleDialogStore((s) => s.path);
  const clear = useNoteTitleDialogStore((s) => s.clear);
  if (!path) return null;
  return <DialogBody key={path} path={path} startCleared={clear} />;
}

function DialogBody({ path, startCleared }: { path: string; startCleared: boolean }) {
  const fileName = getFileName(path);
  const [current, setCurrent] = useState<string | null | undefined>(undefined);
  const [value, setValue] = useState("");
  const [updateLinks, setUpdateLinks] = useState(true);
  const [preview, setPreview] = useState<RetitleResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let stale = false;
    readNoteTitleOverride(path)
      .then((t) => {
        if (stale) return;
        setCurrent(t);
        setValue(startCleared ? "" : (t ?? ""));
        requestAnimationFrame(() => inputRef.current?.select());
      })
      .catch((e: unknown) => {
        if (!stale) setError(describe(e));
      });
    return () => {
      stale = true;
    };
  }, [path, startCleared]);

  const trimmed = value.trim();
  const unchanged = current !== undefined && (current ?? "") === trimmed;
  const multiline = /[\r\n]/.test(value);

  // How many links would change: a dry run of the same plan the save applies.
  useEffect(() => {
    if (current === undefined || unchanged || multiline || current === null) {
      setPreview(null);
      return;
    }
    let stale = false;
    const timer = setTimeout(() => {
      retitleNote(path, trimmed === "" ? null : trimmed, { updateLinks: true, dryRun: true })
        .then((r) => {
          if (!stale) setPreview(r);
        })
        .catch(() => {
          if (!stale) setPreview(null);
        });
    }, 150);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [path, trimmed, current, unchanged, multiline]);

  async function submit(next: string | null) {
    setBusy(true);
    setError(null);
    try {
      await applyNoteTitle(path, next, updateLinks);
      closeNoteTitleDialog();
    } catch (e) {
      setError(describe(e));
      setBusy(false);
    }
  }

  const linkCount = preview?.links ?? 0;
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  return (
    <ModalShell
      labelledBy="note-title-heading"
      onClose={closeNoteTitleDialog}
      initialFocus={inputRef}
      className={`w-full max-w-[460px] ${MODAL_PANEL} px-5 pb-4 pt-5`}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy && !unchanged && !multiline) void submit(trimmed === "" ? null : trimmed);
        }}
      >
        <h2
          id="note-title-heading"
          className="text-[15px] font-semibold text-[var(--text-primary)]"
        >
          Set display title
        </h2>
        <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-muted)]">
          File: <span className="text-[var(--text-secondary)]">{fileName}</span>. This does not
          rename the file. Links keep pointing to {fileName}. The title is saved as the{" "}
          <code>title</code> property.
        </p>
        <label className="mt-4 block">
          <span className="text-[12px] font-medium text-[var(--text-secondary)]">
            Display title
          </span>
          <input
            ref={inputRef}
            type="text"
            value={value}
            disabled={current === undefined}
            placeholder="Shown instead of the file name"
            onChange={(e) => {
              setValue(e.target.value);
              if (error) setError(null);
            }}
            className={`${FIELD} mt-1.5 h-9`}
          />
        </label>
        {current !== null && current !== undefined && linkCount > 0 ? (
          <label className="mt-3 flex items-start gap-2 text-[12px] text-[var(--text-secondary)]">
            <input
              type="checkbox"
              checked={updateLinks}
              onChange={(e) => setUpdateLinks(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              Update links that show the old title
              <span className="block text-[var(--text-muted)]">
                {plural(linkCount, "link")} in {plural(preview?.files ?? 0, "note")} show &ldquo;
                {current}&rdquo; (as [[{fileName.replace(/\.md$/i, "")}|{current}]]).
              </span>
            </span>
          </label>
        ) : null}
        {error ? (
          <p role="alert" className="mt-3 text-[12px] text-[var(--text-muted)]">
            {error}
          </p>
        ) : null}
        <div className="mt-4 flex items-center justify-end gap-2">
          {current ? (
            <button
              type="button"
              className={`${BUTTON} mr-auto`}
              disabled={busy}
              onClick={() => void submit(null)}
            >
              Clear display title
            </button>
          ) : null}
          <button type="button" className={BUTTON} onClick={closeNoteTitleDialog}>
            Cancel
          </button>
          <button type="submit" className={PRIMARY} disabled={busy || unchanged || multiline}>
            {trimmed === "" ? "Clear" : "Set title"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
