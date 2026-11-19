import { EditorView } from "@codemirror/view";
import { Suspense, lazy, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { drawingsHandledNatively } from "@/lib/drawing-files";
import {
  activateLink,
  keyIntent,
  linkHandlers,
  resolveVaultLink,
  type LinkTarget,
} from "@/lib/link-activation";
import { logger } from "@/lib/logger";
import { readFile } from "@/lib/tauri";
import { useDiskStore } from "../disk-sync";
import { renderSvg } from "../lib/export-svg";
import { useInlineEditor } from "../lib/inline-editor";
import { flushLiveView } from "../lib/live-views";

// The canvas is its own chunk, fetched on the first click into a picture.
const DrawingCanvas = lazy(() =>
  import("./drawing-canvas").then((m) => ({ default: m.DrawingCanvas })),
);

const MIN_EDIT_HEIGHT = 200;

type State =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "error"; message: string }
  | { status: "ready"; path: string; src: string };

/**
 * A drawing shown in a note (ADR 2026-11-18, point 6): the live SVG of the file, redrawn when
 * the file changes (`disk-sync`, or a save of Writer's own) and cached by content hash
 * (`renderSvg`), as an `<img>` of a data URL: a picture can run no script and the CSP already
 * allows `data:` images. A click edits it in place (the same canvas as the tab, over the same
 * session, at the picture's height; Esc or a click outside returns to the picture; one editor at
 * a time, `lib/inline-editor.ts`). Middle click and Cmd/Ctrl+click open a new tab like any link.
 * With the drawings handed to the Obsidian plugin there is no canvas of ours: a click opens the
 * drawing's tab, as before.
 */
export function DrawingEmbed({
  target,
  notePath,
  host,
}: {
  target: string;
  notePath: string;
  /** The widget's element: what names this embed among the others. */
  host: HTMLElement;
}) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [path, setPath] = useState<string | null>(null);
  const version = useDiskStore((s) =>
    path ? (s.views[path]?.version ?? 0) + (s.views[path]?.saves ?? 0) : 0,
  );
  const editing = useInlineEditor((s) => s.host === host);
  const [editHeight, setEditHeight] = useState(MIN_EDIT_HEIGHT);
  const picture = useRef<HTMLDivElement>(null);
  const dark = document.documentElement.getAttribute("data-theme") === "dark";

  useEffect(() => {
    let live = true;
    resolveVaultLink(target, notePath).then(
      (r) => {
        if (!live) return;
        if (r.kind === "internal") setPath(r.path);
        else setState({ status: "missing" });
      },
      (e: unknown) => live && setState({ status: "error", message: String(e) }),
    );
    return () => {
      live = false;
    };
  }, [target, notePath]);

  useEffect(() => {
    if (!path) return;
    useDiskStore.getState().track(path);
    return () => useDiskStore.getState().forget(path);
  }, [path]);

  useEffect(() => {
    if (!path || editing) return; // the picture is redrawn from the saved scene when editing ends
    let live = true;
    readFile(path)
      .then((file) => renderSvg(path, file.content, dark))
      .then(
        (markup) => {
          if (live) {
            setState({
              status: "ready",
              path,
              src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`,
            });
          }
        },
        (e: unknown) => {
          logger.warn("excalidraw", `an embedded drawing did not render: ${String(e)}`);
          if (live) setState({ status: "error", message: "The drawing could not be shown" });
        },
      );
    return () => {
      live = false;
    };
  }, [path, version, dark, editing]);

  if (editing && path) {
    return (
      <InlineEditor
        path={path}
        height={editHeight}
        onClose={() => {
          useInlineEditor.getState().exit(host);
          void flushLiveView(path);
        }}
      />
    );
  }
  if (state.status === "ready") {
    const link: LinkTarget = { kind: "file", path: state.path };
    const edit = () => {
      if (!drawingsHandledNatively()) return activateLink(link, "current");
      setEditHeight(
        Math.max(MIN_EDIT_HEIGHT, picture.current?.getBoundingClientRect().height ?? 0),
      );
      useInlineEditor.getState().enter(host);
    };
    // a plain click edits; every other gesture is the shared link's
    const onKeyDown = (e: KeyboardEvent) => {
      const intent = keyIntent(e.nativeEvent);
      if (!intent) return;
      e.preventDefault();
      if (intent === "current") edit();
      else activateLink(link, intent);
    };
    return (
      <div
        ref={picture}
        data-drawing-embed
        role="link"
        tabIndex={0}
        aria-label={`Drawing ${target}`}
        className="cursor-pointer"
        {...linkHandlers(link, { onCurrent: edit })}
        onKeyDown={onKeyDown}
      >
        <img src={state.src} alt={target} className="block h-auto max-w-full" draggable={false} />
      </div>
    );
  }
  return (
    <div
      data-drawing-embed
      role="status"
      className="rounded-md border border-[var(--line-subtler)] px-3 py-2 text-[12px] text-[var(--text-muted)]"
    >
      {state.status === "loading"
        ? `Loading ${target}`
        : state.status === "missing"
          ? `Drawing not found: ${target}`
          : state.message}
    </div>
  );
}

/** The canvas in the note, at the picture's height and the editor's content width. Esc (outside a
 *  text box) or a press outside it goes back to the picture. */
function InlineEditor({
  path,
  height,
  onClose,
}: {
  path: string;
  height: number;
  onClose: () => void;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const onPress = (e: PointerEvent) => {
      const el = e.target instanceof Element ? e.target : null;
      // Excalidraw's menus and dialogs may sit in a portal outside the stage
      if (el && !stage.current?.contains(el) && !el.closest(".excalidraw")) close.current();
    };
    document.addEventListener("pointerdown", onPress, true);
    return () => document.removeEventListener("pointerdown", onPress, true);
  }, []);

  return (
    <div
      ref={stage}
      data-drawing-embed
      data-drawing-embed-editor
      data-path={path}
      style={{ height }}
      onKeyDown={(e) => {
        const el = e.target instanceof Element ? e.target : null;
        // a text box of the canvas (the note's own contenteditable is around the stage)
        const box = el?.closest("textarea, input, [contenteditable='true']");
        const typing = box != null && stage.current?.contains(box) === true;
        if (e.key === "Escape" && !typing) {
          e.preventDefault();
          // Esc hands the keyboard back to the note (a click outside already put focus there)
          const root = stage.current?.closest<HTMLElement>(".cm-editor");
          const note = root ? EditorView.findFromDOM(root) : null;
          close.current();
          note?.focus();
        }
      }}
    >
      <Suspense
        fallback={
          <div className="px-3 py-2 text-[12px] text-[var(--text-muted)]">Loading drawing</div>
        }
      >
        <DrawingCanvas path={path} />
      </Suspense>
    </div>
  );
}
