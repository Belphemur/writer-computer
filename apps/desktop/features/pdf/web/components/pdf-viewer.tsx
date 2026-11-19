import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { PdfLocation } from "@/components/editor-area/page-kinds/pdf";
import { ZoomControl } from "@/components/zoom-control";
import type { PageViewProps } from "@/lib/features/slots";
import { logger } from "@/lib/logger";
import { getFileName } from "@/lib/paths";
import { parsePdfAnchor } from "@/lib/pdf-anchor";
import { registerAnchorReveal, takePendingAnchor } from "@/lib/pending-anchor";
import { openAttachmentInDefaultApp } from "@/lib/tauri";
import { usePdfDocument } from "../lib/use-pdf-document";
import { registerViewer } from "../lib/viewer-controller";
import { FindBar } from "./find-bar";
import { PageBox } from "./page-box";
import { PdfReader, type ReaderApi, type ReaderState } from "./pdf-reader";

const NO_FIND = { query: "", count: 0, current: 0, searching: false };

/**
 * The PDF tab (page kind `pdf`, slot `page-view:pdf`): the reader (`./pdf-reader.tsx`), the footer
 * (page `x / n`, zoom), the find bar and the anchors. `[[x.pdf#page=3]]` parks `page=3` for the
 * path (`lib/pending-anchor.ts`): it is taken when the tab mounts or becomes active, and an open
 * active tab scrolls at once through the registered reveal. Cmd/Ctrl `=`, `-`, `0` and `F` reach
 * the reader through `../lib/viewer-controller.ts`. Kept alive like every viewer tab: inactive, it
 * hides with `invisible` (docs/design.md).
 */
export function PdfViewer({ location, isActive }: PageViewProps<PdfLocation>) {
  const path = location.path;
  const source = usePdfDocument(path);
  const apiRef = useRef<ReaderApi | null>(null);
  const [state, setState] = useState<ReaderState | null>(null);
  const [goTo, setGoTo] = useState<{ page: number; id: number } | undefined>();
  const nonce = useRef(0);
  const [findOpen, setFindOpen] = useState(false);
  const [findToken, setFindToken] = useState(0);
  const active = useRef(isActive);
  active.current = isActive;

  const goToPage = useCallback((page: number) => setGoTo({ page, id: ++nonce.current }), []);

  // A link's `#page=N`, parked for this path: taken when the tab shows (mounted or activated).
  useEffect(() => {
    if (!isActive) return;
    const anchor = takePendingAnchor(path);
    const page = anchor ? parsePdfAnchor(anchor.anchor).page : null;
    if (page !== null) goToPage(page);
  }, [isActive, path, goToPage]);

  // The same link followed while this tab is open and active: scroll now.
  useEffect(
    () =>
      registerAnchorReveal((p, anchor) => {
        const page = p === path && active.current ? parsePdfAnchor(anchor).page : null;
        if (page === null) return false;
        goToPage(page);
        return true;
      }),
    [path, goToPage],
  );

  const openFind = useCallback(() => {
    setFindOpen(true);
    setFindToken((t) => t + 1);
  }, []);
  const closeFind = useCallback(() => {
    apiRef.current?.find.clear();
    setFindOpen(false);
  }, []);

  useEffect(
    () =>
      isActive
        ? registerViewer({
            zoomIn: () => apiRef.current?.zoomIn(),
            zoomOut: () => apiRef.current?.zoomOut(),
            fit: () => apiRef.current?.fit(),
            find: openFind,
          })
        : undefined,
    [isActive, openFind],
  );

  const name = getFileName(path);
  return (
    <div
      data-pane
      data-testid="pdf-viewer"
      className={
        isActive
          ? "relative z-10 flex h-full flex-col"
          : "absolute inset-0 invisible pointer-events-none"
      }
    >
      <div className="relative min-h-0 flex-1">
        {source.status === "ready" ? (
          <PdfReader
            doc={source.doc}
            zoomable
            goTo={goTo}
            apiRef={apiRef}
            onState={setState}
            testId="pdf-viewer-scroller"
          />
        ) : source.status === "error" ? (
          <Unreadable path={path} password={source.reason === "password"} />
        ) : (
          <Message testId="pdf-viewer-loading">Opening {name}</Message>
        )}
        {findOpen && source.status === "ready" ? (
          <FindBar
            api={apiRef}
            find={state?.find ?? NO_FIND}
            focusToken={findToken}
            onClose={closeFind}
          />
        ) : null}
      </div>
      {state ? (
        <div
          data-testid="pdf-viewer-footer"
          className="flex h-11 shrink-0 items-center justify-end gap-5 px-6 text-[13px] leading-[1.15] text-[var(--text-muted)] md:px-8"
        >
          <PageBox
            page={state.page}
            pageCount={state.pageCount}
            onGo={(page) => apiRef.current?.goToPage(page)}
          />
          <ZoomControl
            scale={state.scale}
            fitted={state.fitted}
            fitTitle="Fit to width"
            testId="pdf-zoom"
            onZoomIn={() => apiRef.current?.zoomIn()}
            onZoomOut={() => apiRef.current?.zoomOut()}
            onFit={() => apiRef.current?.fit()}
          />
        </div>
      ) : null}
    </div>
  );
}

function Message({ testId, children }: { testId: string; children: ReactNode }) {
  return (
    <div
      data-testid={testId}
      className="flex h-full flex-col items-center justify-center gap-2 text-[13px] text-[var(--text-muted)]"
    >
      {children}
    </div>
  );
}

function Unreadable({ path, password }: { path: string; password: boolean }) {
  const [openError, setOpenError] = useState(false);
  return (
    <Message testId="pdf-viewer-error">
      <div>{password ? "This PDF needs a password" : "Can't display this PDF here"}</div>
      <button
        type="button"
        className="rounded-md border border-[var(--line-subtle)] px-2.5 py-1 text-[var(--text-primary)] hover:bg-[var(--item-hover-bg)]"
        onClick={() => {
          setOpenError(false);
          openAttachmentInDefaultApp(path).catch((error: unknown) => {
            logger.warn("pdf", `open in default app failed: ${String(error)}`);
            setOpenError(true);
          });
        }}
      >
        Open in default app
      </button>
      {openError ? <div>Couldn't open it</div> : null}
    </Message>
  );
}
