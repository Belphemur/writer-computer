// The merge view (page kind `git-merge`, spec `SPECs/git-sync-spec.md` "Merge view"): Mine, Result
// and Theirs side by side for one file a sync could not merge. Every overlap offers Take mine, Take
// theirs and Take both above the Result (an editable CodeMirror editor); front matter conflicts
// are chosen per property; after a rename the path is chosen too. Save writes the Result, commits
// it and resumes the sync; Cancel closes the tab and leaves the file conflicted. One scroller: the
// root; the columns grow with their text. Nothing here writes until Save.
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useEffect, useMemo, useRef, useState } from "react";
import type { GitMergeLocation } from "@/components/editor-area/page-kinds";
import { closeTab, getOpenFile } from "@/hooks/editor-api";
import { serializeDocument } from "@/lib/frontmatter";
import type { PageViewProps } from "@/lib/features/slots";
import { describeError, logger } from "@/lib/logger";
import { conflictOpen, conflictSave, type ConflictView } from "../ipc";
import { resultExtensions, sideExtensions, hunkField } from "../lib/merge-editor";
import { allPicked, layoutOf, pickRows, valueOf, type Picks } from "../lib/merge-model";
import { useGitStatus } from "../lib/status-store";
import { BUTTON } from "./sync-parts";

/** The user's buffer when the note is open with unsaved typing: the view shows what they see. */
function openBuffer(path: string): string | null {
  const file = getOpenFile(path);
  if (!file?.isDirty) return null;
  return serializeDocument(file.frontmatter, file.content);
}

/** A CodeMirror view over `doc` that lives as long as its inputs. */
function useEditor(doc: string, extensions: () => import("@codemirror/state").Extension) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  useEffect(() => {
    if (!host.current) return;
    const v = new EditorView({
      state: EditorState.create({ doc, extensions: extensions() }),
      parent: host.current,
    });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
    // the editor is made once per loaded view: its inputs do not change under it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return { host, view };
}

function Column({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="min-w-0">
      <h3 className="px-2 pb-1 text-[11px] font-medium tracking-wide text-[var(--text-muted)] uppercase">
        {title}
      </h3>
      <div className="rounded-md border border-[var(--border-color)]">{children}</div>
    </section>
  );
}

function PropertyRows({
  view,
  picks,
  onPick,
}: {
  view: ConflictView;
  picks: Picks;
  onPick: (name: string, side: "mine" | "theirs") => void;
}) {
  if (view.properties.length === 0) return null;
  return (
    <section data-git-merge-properties aria-label="Properties" className="space-y-1">
      <h3 className="text-[11px] font-medium tracking-wide text-[var(--text-muted)] uppercase">
        Properties
      </h3>
      {view.properties.map((p) => (
        <div
          key={p.name}
          data-git-merge-property={p.name}
          className="flex flex-wrap items-baseline gap-2 text-[12.5px]"
        >
          <span className="w-28 shrink-0 font-medium text-[var(--text-primary)]">{p.name}</span>
          {(["mine", "theirs"] as const).map((side) => (
            <button
              key={side}
              type="button"
              data-git-merge-pick={side}
              aria-pressed={picks[p.name] === side}
              className={`${BUTTON} max-w-[40%] truncate font-[var(--mono-font)] ${
                picks[p.name] === side ? "bg-[var(--surface-subtle)]" : ""
              }`}
              title={p[side] ?? ""}
              onClick={() => onPick(p.name, side)}
            >
              {side === "mine" ? "Mine" : "Theirs"}: {p[side] === null ? "none" : valueOf(p[side])}
            </button>
          ))}
        </div>
      ))}
    </section>
  );
}

function PathChoice({
  view,
  value,
  onChange,
}: {
  view: ConflictView;
  value: string;
  onChange: (path: string) => void;
}) {
  if (!view.theirsPath) return null;
  return (
    <fieldset data-git-merge-paths className="space-y-1 text-[12.5px]">
      <legend className="text-[11px] font-medium tracking-wide text-[var(--text-muted)] uppercase">
        Name
      </legend>
      {[
        { path: view.path, label: "Mine" },
        { path: view.theirsPath, label: "Theirs" },
      ].map((o) => (
        <label key={o.path} className="flex items-center gap-2">
          <input
            type="radio"
            name="git-merge-path"
            checked={value === o.path}
            onChange={() => onChange(o.path)}
          />
          <span className="text-[var(--text-muted)]">{o.label}</span>
          <span className="truncate text-[var(--text-primary)]" title={o.path}>
            {o.path}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

function Merge({ view, tabId }: { view: ConflictView; tabId: string }) {
  const layout = useMemo(() => layoutOf(view.parts), [view]);
  const [open, setOpen] = useState(layout.hunks.length);
  const [picks, setPicks] = useState<Picks>({});
  const [finalPath, setFinalPath] = useState(view.path);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const apply = useGitStatus((s) => s.apply);
  const mine = useEditor(layout.mineDoc, () => sideExtensions(layout.hunks.map((h) => h.inMine)));
  const theirs = useEditor(layout.theirsDoc, () =>
    sideExtensions(layout.hunks.map((h) => h.inTheirs)),
  );
  const result = useEditor(layout.resultDoc, () =>
    resultExtensions(layout.hunks, (state) =>
      setOpen(state.field(hunkField).filter((h) => h.choice === null).length),
    ),
  );

  const ready = open === 0 && allPicked(view.properties, picks) && !busy;
  const left = open + view.properties.filter((p) => picks[p.name] === undefined).length;

  const save = async () => {
    const body = result.view.current?.state.doc.toString();
    if (body === undefined) return;
    setBusy(true);
    setFailure(null);
    try {
      apply(
        await conflictSave(view.path, {
          mine: view.mine,
          body,
          picks: pickRows(picks),
          finalPath: view.theirsPath ? finalPath : null,
        }),
      );
      closeTab(tabId);
    } catch (e) {
      logger.warn("git", "the merge could not be saved");
      setFailure(describeError(e).message);
      setBusy(false);
    }
  };

  return (
    <div data-git-merge className="flex min-h-full flex-col gap-3 p-4 text-[13px]">
      <header className="flex items-center gap-3">
        <h2 className="min-w-0 flex-1 truncate text-[14px] font-medium text-[var(--text-primary)]">
          {view.path}
        </h2>
        <span data-git-merge-left className="text-xs text-[var(--text-muted)]">
          {left > 0 ? `${left} left` : "Ready"}
        </span>
        <button type="button" className={BUTTON} onClick={() => closeTab(tabId)}>
          Cancel
        </button>
        <button
          type="button"
          data-git-merge-save
          className={BUTTON}
          disabled={!ready}
          onClick={() => void save()}
        >
          Save
        </button>
      </header>
      {failure && (
        <p role="alert" className="text-xs text-[var(--text-primary)]">
          {failure}
        </p>
      )}
      <PathChoice view={view} value={finalPath} onChange={setFinalPath} />
      <PropertyRows
        view={view}
        picks={picks}
        onPick={(name, side) => setPicks((p) => ({ ...p, [name]: side }))}
      />
      <div className="grid min-h-0 flex-1 grid-cols-3 gap-3">
        <Column title="Mine">
          <div ref={mine.host} data-git-merge-column="mine" />
        </Column>
        <Column title="Result">
          <div ref={result.host} data-git-merge-column="result" />
        </Column>
        <Column title="Theirs">
          <div ref={theirs.host} data-git-merge-column="theirs" />
        </Column>
      </div>
    </div>
  );
}

/** The tab body. */
export default function MergePage({ location, tabId }: PageViewProps<GitMergeLocation>) {
  const [view, setView] = useState<ConflictView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    conflictOpen(location.path, openBuffer(location.path)).then(
      (v) => current && setView(v),
      (e) => {
        if (!current) return;
        logger.warn("git", "could not open the merge view");
        setError(describeError(e).message);
      },
    );
    return () => {
      current = false;
    };
  }, [location.path]);
  if (error) {
    return (
      <div data-git-merge-empty className="flex flex-col items-start gap-2 p-4 text-[13px]">
        <p className="text-[var(--text-primary)]">{error}</p>
        <button type="button" className={BUTTON} onClick={() => closeTab(tabId)}>
          Close
        </button>
      </div>
    );
  }
  if (!view) return null;
  return <Merge view={view} tabId={tabId} />;
}
