import { memo, useEffect, useRef } from "react";
import { EditorView } from "@codemirror/view";
import { EditorState, Transaction } from "@codemirror/state";
import { closeEditorSearch } from "@/components/editor-area/editor-search-store";
import { useCloseEditorSearchWhenInactive } from "@/components/editor-area/use-close-editor-search-when-inactive";
import { useIsFileLoading, useReloadVersion } from "@/hooks/use-tabs";
import { useBooleanSetting } from "@/hooks/use-settings";
import * as editorApi from "@/hooks/editor-api";
import {
  CODE_READ_ONLY_BYTES,
  codeLanguageFor,
  defaultIndentFor,
  detectIndent,
  isOverReadOnlyLimit,
} from "@/lib/code-files";
import { getFileName } from "@/lib/paths";
import type { CodeLocation } from "@/components/editor-area/page-kinds/code";
import {
  createCodeEditorCompartments,
  createCodeEditorExtensions,
  indentExtension,
  loadLanguageExtension,
  readOnlyExtension,
  wrapExtension,
} from "./code-editor-extensions";
import { ManagedSkillBanner } from "./managed-skill-banner";
import "@/components/editor-area/prosemark-theme.css";
import "./code-editor.css";

function CodeEditorView({ path, isActive }: { path: string; isActive: boolean }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const compartmentsRef = useRef(createCodeEditorCompartments());
  const disposedRef = useRef(false);
  const pathRef = useRef(path);
  pathRef.current = path;
  const reloadVersion = useReloadVersion(path);
  const lastReloadRef = useRef(reloadVersion);
  const wrap = useBooleanSetting("editor.code-word-wrap", false);
  const wrapRef = useRef(wrap);
  wrapRef.current = wrap;
  const activeRef = useRef(isActive);
  activeRef.current = isActive;
  useCloseEditorSearchWhenInactive(isActive);

  // One EditorView per path (a rename re-points the tab, which recreates the view: cursor and
  // scroll come back from the store).
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    disposedRef.current = false;
    const file = editorApi.getOpenFile(path);
    const content = file?.content ?? "";
    const name = getFileName(path);
    const readOnly = isOverReadOnlyLimit(content);
    const indent = detectIndent(content, defaultIndentFor(name));
    const compartments = compartmentsRef.current;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: content,
        extensions: createCodeEditorExtensions({
          getFilePath: () => pathRef.current,
          isDisposed: () => disposedRef.current,
          compartments,
          indent,
          wrap: wrapRef.current,
          readOnly,
        }),
      }),
    });
    viewRef.current = view;
    lastReloadRef.current = file?.reloadVersion ?? 0;

    const cursor = Math.min(file?.cursorPos ?? 0, view.state.doc.length);
    view.dispatch({ selection: { anchor: cursor }, scrollIntoView: false });
    const scroller = host.parentElement;
    const scrollPos = file?.scrollPos ?? 0;
    requestAnimationFrame(() => {
      if (!disposedRef.current && scroller) scroller.scrollTo(0, Math.max(0, scrollPos));
    });
    const onScroll = () => {
      if (scroller) editorApi.updateScrollPos(pathRef.current, scroller.scrollTop);
    };
    scroller?.addEventListener("scroll", onScroll, { passive: true });

    // Highlighting: the language resolves from the file name through the language data the
    // markdown editor uses for fenced code; it loads lazily and is applied when ready.
    let cancelled = false;
    void loadLanguageExtension(codeLanguageFor(name)).then((extension) => {
      if (cancelled || disposedRef.current) return;
      view.dispatch({ effects: compartments.language.reconfigure(extension) });
    });

    if (activeRef.current) view.focus();
    return () => {
      cancelled = true;
      disposedRef.current = true;
      scroller?.removeEventListener("scroll", onScroll);
      closeEditorSearch({ view });
      view.destroy();
      viewRef.current = null;
    };
  }, [path]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: compartmentsRef.current.wrap.reconfigure(wrapExtension(wrap)) });
  }, [wrap]);

  // An external change (or an agent edit) reloaded the file: swap the text in place.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || reloadVersion === lastReloadRef.current) return;
    lastReloadRef.current = reloadVersion;
    const content = editorApi.getOpenFile(path)?.content ?? "";
    const name = getFileName(path);
    const head = Math.min(view.state.selection.main.head, content.length);
    const compartments = compartmentsRef.current;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content },
      selection: { anchor: head },
      annotations: Transaction.addToHistory.of(false),
      userEvent: "writer.reload",
      scrollIntoView: false,
      effects: [
        compartments.readOnly.reconfigure(readOnlyExtension(isOverReadOnlyLimit(content))),
        compartments.indent.reconfigure(
          indentExtension(detectIndent(content, defaultIndentFor(name))),
        ),
      ],
    });
  }, [reloadVersion, path]);

  return <div ref={hostRef} data-code-editor className="min-h-full" />;
}

export const CodeEditorPane = memo(function CodeEditorPane({
  location,
  isActive,
}: {
  location: CodeLocation;
  isActive: boolean;
}) {
  const path = location.path;
  const isLoading = useIsFileLoading(path);
  const content = editorApi.getOpenFile(path)?.content ?? "";
  const readOnly = !isLoading && isOverReadOnlyLimit(content);
  return (
    <div
      data-pane
      className={
        isActive ? "relative z-10 h-full" : "absolute inset-0 invisible pointer-events-none"
      }
    >
      {isLoading ? (
        <div className="flex h-full items-center justify-center text-[13px] text-[var(--text-muted)]">
          …
        </div>
      ) : (
        <div className="writer-code-editor h-full overflow-auto">
          {readOnly ? (
            <div
              role="status"
              data-testid="code-read-only-banner"
              className="sticky left-0 top-0 z-10 px-4 py-1.5 text-[12px] text-[var(--text-muted)]"
              style={{ background: "var(--surface-card)" }}
            >
              {`Large file (over ${CODE_READ_ONLY_BYTES / (1024 * 1024)} MiB): opened read-only.`}
            </div>
          ) : null}
          <CodeEditorView path={path} isActive={isActive} />
        </div>
      )}
      {isActive ? <ManagedSkillBanner path={path} /> : null}
    </div>
  );
});
