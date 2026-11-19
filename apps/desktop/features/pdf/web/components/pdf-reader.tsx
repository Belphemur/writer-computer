import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import { useElementSize } from "@/hooks/use-element-size";
import { useZoomGestures } from "@/hooks/use-zoom-gestures";
import { scrollIntoScroller } from "@/lib/scroll-into";
import { ZOOM_STEP, type Point, type Size } from "@/lib/viewer-zoom";
import { applyMarks } from "../lib/find-marks";
import {
  anchorAt,
  clampPage,
  clampZoom,
  currentPage,
  fitWidthScale,
  layoutPages,
  renderRange,
  scrollTopOfPage,
  stackWidth,
  yOfAnchor,
  type Anchor,
  type Layout,
} from "../lib/page-layout";
import type { PdfDocument, TextLayerHandle } from "../lib/pdf-lib";
import { useFind } from "../lib/use-find";
import { PdfPage } from "./pdf-page";
import "../pdf.css";

/** A zoom that lands this close to Fit becomes Fit (so a resize keeps following the width). */
const FIT_SNAP = 0.005;
/** The size assumed for pages whose real size is not read yet (US Letter). */
const DEFAULT_PAGE: Size = { width: 612, height: 792 };
/** Pages whose size is read per round. */
const SIZE_BATCH = 50;

export interface ReaderFindState {
  query: string;
  /** Matches found so far. */
  count: number;
  /** 1-based number of the current match, 0 for none. */
  current: number;
  searching: boolean;
}

/** What the reader reports: the page it is on, the zoom, the find result. */
export interface ReaderState {
  page: number;
  pageCount: number;
  scale: number;
  /** Zoom follows the width (Fit), not a chosen percent. */
  fitted: boolean;
  find: ReaderFindState;
}

/** What the reader lets its owner do (the viewer's footer, the commands, the find bar). */
export interface ReaderApi {
  goToPage(page: number): void;
  zoomIn(): void;
  zoomOut(): void;
  fit(): void;
  find: {
    setQuery(query: string): void;
    next(): void;
    prev(): void;
    clear(): void;
  };
}

interface Props {
  doc: PdfDocument;
  /** Pinch and Cmd/Ctrl + wheel zoom (the tab; an embed only fits the width). */
  zoomable: boolean;
  /** Scroll to `page` whenever `id` changes (and once the layout exists). */
  goTo?: { page: number; id: number };
  apiRef: MutableRefObject<ReaderApi | null>;
  onState: (state: ReaderState) => void;
  testId: string;
  className?: string;
}

/**
 * The reader: every page of `doc` in one vertical scroller (spec SPECs/pdf-spec.md, "Tab viewer").
 * Geometry is `../lib/page-layout.ts` (pure); only pages near the viewport draw a canvas, a text
 * layer and links (`./pdf-page.tsx`), the others are sized boxes, so a long PDF costs a few pages
 * of work. The width fits by default; a zoom keeps the page under the pointer (or the middle of
 * the viewport) where it was, and a change of layout (the sizes of the pages arriving, a resize)
 * keeps the reading position by anchoring to a page and a fraction of it. Find marks the text
 * layers; the root is `data-selectable` so the text copies.
 */
export const PdfReader = memo(function PdfReader({
  doc,
  zoomable,
  goTo,
  apiRef,
  onState,
  testId,
  className,
}: Props) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const viewer = useElementSize(scrollerRef);
  const [sizes, setSizes] = useState<Size[]>(() =>
    Array.from({ length: doc.numPages }, () => DEFAULT_PAGE),
  );
  const [zoom, setZoom] = useState<number | null>(null);
  const [range, setRange] = useState<{ first: number; last: number } | null>(null);
  const [page, setPage] = useState(1);
  const find = useFind(doc);

  // Page sizes: the first one at once (every page is assumed to match it), the rest in rounds.
  useEffect(() => {
    let live = true;
    const count = doc.numPages;
    (async () => {
      const first = await doc.pageSize(1);
      if (!live) return;
      const all = Array.from({ length: count }, () => first);
      setSizes(all);
      for (let from = 2; from <= count; from += SIZE_BATCH) {
        const pages = Array.from(
          { length: Math.min(SIZE_BATCH, count - from + 1) },
          (_, i) => from + i,
        );
        const read = await Promise.all(pages.map((p) => doc.pageSize(p).catch(() => first)));
        if (!live) return;
        read.forEach((size, i) => (all[pages[i]! - 1] = size));
        setSizes([...all]);
      }
    })().catch(() => {
      // a document whose first page cannot be measured keeps the assumed size
    });
    return () => {
      live = false;
    };
  }, [doc]);

  const fit = fitWidthScale(sizes, viewer.width);
  const scale = zoom ?? fit;
  const layout = useMemo(() => layoutPages(sizes, scale), [sizes, scale]);

  const latest = useRef({ layout, fit, zoom: null as number | null });
  latest.current.layout = layout;
  latest.current.fit = fit;
  /** Where the reader is, as a page and a fraction of it; null until the first read (the top). */
  const anchor = useRef<Anchor | null>(null);
  const pendingScroll = useRef<{
    top: (next: Layout) => number;
    left: (nextStackWidth: number) => number;
  } | null>(null);

  /** Read the scroller: the reading anchor, the pages to draw, the page the reader is on. */
  const sync = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const l = latest.current.layout;
    anchor.current = anchorAt(l, el.scrollTop);
    const next = renderRange(l, el.scrollTop, el.clientHeight);
    setRange((prev) =>
      prev && next && prev.first === next.first && prev.last === next.last ? prev : next,
    );
    setPage(currentPage(l, el.scrollTop, el.clientHeight));
  }, []);

  // The layout changed: put the reader back where it was (or where a zoom asked), then draw.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const pending = pendingScroll.current;
    pendingScroll.current = null;
    if (pending) {
      el.scrollTop = pending.top(layout);
      el.scrollLeft = pending.left(stackWidth(layout, viewer.width));
    } else if (anchor.current) {
      el.scrollTop = yOfAnchor(layout, anchor.current);
    }
    sync();
    // viewer.width only feeds the pending horizontal position
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, sync]);
  useEffect(sync, [viewer.height, sync]);

  const goToPage = useCallback(
    (target: number) => {
      const el = scrollerRef.current;
      const n = clampPage(target, doc.numPages);
      if (!el || n === null) return;
      el.scrollTop = scrollTopOfPage(latest.current.layout, n);
      sync();
    },
    [doc, sync],
  );

  const goToId = goTo?.id;
  const goToTarget = goTo?.page;
  const ready = viewer.width > 0;
  useEffect(() => {
    if (goToId === undefined || goToTarget === undefined || !ready) return;
    goToPage(goToTarget);
    // the page of an anchor is applied once per id
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goToId, ready, goToPage]);

  const setZoomValue = useCallback((next: number | null) => {
    latest.current.zoom = next;
    setZoom(next);
  }, []);

  /** Zoom by `factor` keeping the content under `at` (a point of the scroller) where it is. */
  const zoomBy = useCallback(
    (factor: number, at?: Point) => {
      const el = scrollerRef.current;
      if (!el) return;
      const { layout: l, fit: fitScale, zoom: current } = latest.current;
      const target = clampZoom((current ?? fitScale) * factor);
      const point = at ?? { x: el.clientWidth / 2, y: el.clientHeight / 2 };
      const k = target / l.scale;
      const y = el.scrollTop + point.y;
      const under = anchorAt(l, y);
      const dy = y - l.tops[under.page - 1]!;
      const x = el.scrollLeft + point.x;
      const oldStack = stackWidth(l, el.clientWidth);
      pendingScroll.current = {
        top: (next) => next.tops[under.page - 1]! + dy * k - point.y,
        left: (nextStack) => (x - oldStack / 2) * k + nextStack / 2 - point.x,
      };
      setZoomValue(Math.abs(target / fitScale - 1) < FIT_SNAP ? null : target);
    },
    [setZoomValue],
  );

  const pinch = useRef(1);
  useZoomGestures(
    scrollerRef,
    {
      zoomBy,
      pinchStart: () => {
        pinch.current = latest.current.zoom ?? latest.current.fit;
      },
      pinchTo: (s, at) => {
        const base = latest.current.zoom ?? latest.current.fit;
        zoomBy((pinch.current * s) / base, at);
      },
    },
    zoomable,
  );

  // Text layers that are drawn, for find's marks.
  const layers = useRef(new Map<number, TextLayerHandle>());
  const [layerVersion, setLayerVersion] = useState(0);
  const onLayer = useCallback((p: number, handle: TextLayerHandle | null) => {
    if (handle) layers.current.set(p, handle);
    else layers.current.delete(p);
    setLayerVersion((v) => v + 1);
  }, []);

  // Find: mark every drawn page, and bring the current match into view when it changed.
  const { matches, current: currentMatch } = find.state;
  const reveal = useRef(false);
  useEffect(() => {
    reveal.current = currentMatch >= 0;
  }, [currentMatch, find.state.query]);
  useEffect(() => {
    const byPage = new Map<number, typeof matches>();
    for (const m of matches) byPage.set(m.page, [...(byPage.get(m.page) ?? []), m]);
    const wanted = matches[currentMatch];
    let firstMark: HTMLElement | null = null;
    for (const [p, handle] of layers.current) {
      const onPage = byPage.get(p) ?? [];
      const mark = applyMarks(handle, onPage, wanted ? onPage.indexOf(wanted) : -1);
      if (mark && wanted?.page === p) firstMark = mark;
    }
    const scroller = scrollerRef.current;
    if (!wanted || !reveal.current || !scroller) return;
    if (firstMark) {
      reveal.current = false;
      scrollIntoScroller(firstMark, { block: "center", scroller });
    } else if (!layers.current.has(wanted.page)) {
      goToPage(wanted.page); // not drawn yet: go there, the mark follows when its layer is ready
    }
  }, [matches, currentMatch, layerVersion, goToPage]);

  const pageCount = doc.numPages;
  const findState: ReaderFindState = {
    query: find.state.query,
    count: matches.length,
    current: currentMatch + 1,
    searching: find.state.searching,
  };
  const { setQuery, next, prev, clear } = find;
  apiRef.current = {
    goToPage,
    zoomIn: () => zoomBy(ZOOM_STEP),
    zoomOut: () => zoomBy(1 / ZOOM_STEP),
    fit: () => setZoomValue(null),
    find: { setQuery: (q) => void setQuery(q), next, prev, clear },
  };

  const fitted = zoom === null;
  const { query, count, current, searching } = findState;
  useEffect(() => {
    onState({
      page,
      pageCount,
      scale,
      fitted,
      find: { query, count, current, searching },
    });
  }, [onState, page, pageCount, scale, fitted, query, count, current, searching]);

  const width = stackWidth(layout, viewer.width);
  return (
    <div
      ref={scrollerRef}
      data-selectable
      data-testid={testId}
      className={className ?? "h-full overflow-auto"}
      onScroll={sync}
    >
      <div className="pdf-stack" style={{ width, height: layout.height }}>
        {layout.tops.map((top, i) => {
          const n = i + 1;
          const size = layout.sizes[i]!;
          return (
            <PdfPage
              key={n}
              doc={doc}
              page={n}
              scale={scale}
              width={size.width}
              height={size.height}
              top={top}
              left={(width - size.width) / 2}
              drawn={!!range && n >= range.first && n <= range.last}
              onLayer={onLayer}
              onGoToPage={goToPage}
            />
          );
        })}
      </div>
    </div>
  );
});
