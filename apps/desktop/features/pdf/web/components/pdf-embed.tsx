import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { linkHandlers, openPathAtAnchor, resolveVaultLink } from "@/lib/link-activation";
import type { LinkTarget } from "@/lib/link-activation";
import { usePdfDocument } from "../lib/use-pdf-document";
import { PdfReader, type ReaderApi, type ReaderState } from "./pdf-reader";

type Resolved =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "error" }
  | { status: "ready"; path: string };

/**
 * A PDF shown in a note (spec SPECs/pdf-spec.md, "Links and embeds"): a box of fixed height with
 * its own scroller (the reader, fit to the width, no zoom), the page `x / n` and Open in tab. It
 * starts at the page of `![[x.pdf#page=3]]` and is as tall as `#height=600` says. Open in tab is a
 * link like any other (left click here, middle or Cmd/Ctrl+click in a new tab) and opens at the
 * page the embed is on.
 */
export function PdfEmbed({
  target,
  notePath,
  page,
  height,
}: {
  target: string;
  notePath: string;
  page: number;
  height: number;
}) {
  const [resolved, setResolved] = useState<Resolved>({ status: "loading" });
  useEffect(() => {
    let live = true;
    setResolved({ status: "loading" });
    resolveVaultLink(target, notePath).then(
      (r) => {
        if (!live) return;
        setResolved(
          r.kind === "internal" ? { status: "ready", path: r.path } : { status: "missing" },
        );
      },
      () => live && setResolved({ status: "error" }),
    );
    return () => {
      live = false;
    };
  }, [target, notePath]);

  if (resolved.status !== "ready") {
    return (
      <div
        data-pdf-embed
        role="status"
        className="rounded-md border border-[var(--line-subtler)] px-3 py-2 text-[12px] text-[var(--text-muted)]"
      >
        {resolved.status === "loading"
          ? `Loading ${target}`
          : resolved.status === "missing"
            ? `PDF not found: ${target}`
            : "The PDF could not be found"}
      </div>
    );
  }
  return <Embedded path={resolved.path} target={target} page={page} height={height} />;
}

function Embedded({
  path,
  target,
  page,
  height,
}: {
  path: string;
  target: string;
  page: number;
  height: number;
}) {
  const source = usePdfDocument(path);
  const apiRef = useRef<ReaderApi | null>(null);
  const [state, setState] = useState<ReaderState | null>(null);
  const goTo = useMemo(() => ({ page, id: 0 }), [page]);
  const current = state?.page ?? page;
  const openInTab = useCallback<() => LinkTarget>(
    () => ({
      kind: "custom",
      open: (intent) => void openPathAtAnchor(path, `page=${current}`, intent),
    }),
    [path, current],
  );
  return (
    <div
      data-pdf-embed
      aria-label={`PDF ${target}`}
      className="flex flex-col overflow-clip rounded-md border border-[var(--line-subtler)]"
      style={{ height }}
    >
      <div className="relative min-h-0 flex-1">
        {source.status === "ready" ? (
          <PdfReader
            doc={source.doc}
            zoomable={false}
            goTo={goTo}
            apiRef={apiRef}
            onState={setState}
            testId="pdf-embed-scroller"
          />
        ) : (
          <div
            data-testid="pdf-embed-status"
            className="flex h-full items-center justify-center text-[12px] text-[var(--text-muted)]"
          >
            {source.status === "error" ? "The PDF could not be shown" : `Loading ${target}`}
          </div>
        )}
      </div>
      <div className="flex h-8 shrink-0 items-center justify-between px-3 text-[12px] text-[var(--text-muted)]">
        <span data-testid="pdf-embed-page" className="tabular-nums">
          {state ? `${state.page} / ${state.pageCount}` : ""}
        </span>
        <button
          type="button"
          data-testid="pdf-embed-open"
          className="rounded px-1.5 py-0.5 hover:bg-[var(--item-hover-bg)] hover:text-[var(--text-primary)]"
          {...linkHandlers(openInTab())}
        >
          Open in tab
        </button>
      </div>
    </div>
  );
}
