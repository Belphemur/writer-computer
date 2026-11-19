import { useEffect, useState } from "react";
import { linkHandlers } from "@/lib/link-activation";
import { resolveVaultLink } from "@/lib/link-activation";
import { logger } from "@/lib/logger";
import { readFile } from "@/lib/tauri";
import { useDiskStore } from "../disk-sync";
import { renderSvg } from "../lib/export-svg";

type State =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "error"; message: string }
  | { status: "ready"; path: string; src: string };

/**
 * A drawing shown in a note (ADR 2026-11-18, point 6): the live SVG of the file, redrawn when
 * the file changes (`disk-sync`) and cached by content hash (`renderSvg`), as an `<img>` of a
 * data URL: a picture can run no script and the CSP already allows `data:` images. A click opens
 * the drawing like any link (middle click and Cmd/Ctrl+click open a new tab).
 */
export function DrawingEmbed({ target, notePath }: { target: string; notePath: string }) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [path, setPath] = useState<string | null>(null);
  const version = useDiskStore((s) => (path ? (s.views[path]?.version ?? 0) : 0));
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
    return (
      <div
        data-drawing-embed
        role="link"
        tabIndex={0}
        aria-label={`Drawing ${target}`}
        className="cursor-pointer"
        {...linkHandlers({ kind: "file", path: state.path })}
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
