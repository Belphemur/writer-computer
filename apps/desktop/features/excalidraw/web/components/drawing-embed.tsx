import { EditorView } from "@codemirror/view";
import { useEffect, useState, type KeyboardEvent } from "react";
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
import { openDrawingFullscreen } from "./drawing-fullscreen";

type State =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "error"; message: string }
  | { status: "ready"; path: string; src: string };

/**
 * A drawing shown in a note (ADR 2026-11-18, point 6): the live SVG of the file, redrawn when
 * the file changes (`disk-sync`, or a save of Writer's own) and cached by content hash
 * (`renderSvg`), as an `<img>` of a data URL: a picture can run no script and the CSP already
 * allows `data:` images. A click or Enter opens the drawing full screen, read-only with an Edit
 * button (`drawing-fullscreen.tsx`, the shared shell of `@/lib/fullscreen-overlay`); the note keeps
 * showing the picture. Middle click and Cmd/Ctrl+click open a new tab like any link. With the
 * drawings handed to the Obsidian plugin there is no canvas of ours: a click opens the drawing's
 * tab, as before.
 */
export function DrawingEmbed({
  target,
  notePath,
  host,
}: {
  target: string;
  notePath: string;
  /** The widget's element: how the full screen finds the editor that owns it. */
  host: HTMLElement;
}) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [path, setPath] = useState<string | null>(null);
  const version = useDiskStore((s) =>
    path ? (s.views[path]?.version ?? 0) + (s.views[path]?.saves ?? 0) : 0,
  );
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
    if (!path) return;
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
  }, [path, version, dark]);

  if (state.status === "ready") {
    const link: LinkTarget = { kind: "file", path: state.path };
    const open = () => {
      if (!drawingsHandledNatively()) return activateLink(link, "current");
      const root = host.closest<HTMLElement>(".cm-editor");
      openDrawingFullscreen(
        state.path,
        root ? (EditorView.findFromDOM(root) ?? undefined) : undefined,
      );
    };
    // a plain click opens the full screen; every other gesture is the shared link's
    const onKeyDown = (e: KeyboardEvent) => {
      const intent = keyIntent(e.nativeEvent);
      if (!intent) return;
      e.preventDefault();
      if (intent === "current") open();
      else activateLink(link, intent);
    };
    return (
      <div
        data-drawing-embed
        role="link"
        tabIndex={0}
        aria-label={`Drawing ${target}`}
        className="cursor-pointer"
        {...linkHandlers(link, { onCurrent: open })}
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
