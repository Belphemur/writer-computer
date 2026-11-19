import { memo, useEffect, useRef, useState } from "react";
import { linkHandlers } from "@/lib/link-activation";
import { logger } from "@/lib/logger";
import type { PdfDocument, PdfLink, TextLayerHandle } from "../lib/pdf-lib";

/** A zoom step settles this long before the page is drawn again (the old picture is stretched
 *  meanwhile), so a pinch or a held key does not redraw at every step. */
const REDRAW_DELAY_MS = 90;
/** The most canvas pixels one page may use: above it the picture gets softer, not the memory bigger. */
const MAX_CANVAS_PIXELS = 16_000_000;

/** Device pixels per CSS pixel for a canvas of `width` x `height` CSS pixels, within the budget. */
export function outputScale(width: number, height: number, devicePixelRatio: number): number {
  const wanted = Math.max(1, devicePixelRatio);
  const area = Math.max(1, width * height);
  return Math.min(wanted, Math.sqrt(MAX_CANVAS_PIXELS / area));
}

interface PageProps {
  doc: PdfDocument;
  /** 1-based. */
  page: number;
  scale: number;
  width: number;
  height: number;
  top: number;
  left: number;
  /** Near the viewport: draw the canvas, the text layer and the links; otherwise a placeholder. */
  drawn: boolean;
  onLayer: (page: number, layer: TextLayerHandle | null) => void;
  onGoToPage: (page: number) => void;
}

/**
 * One page of the stack: a sized box that stays in place for every page (the layout never moves
 * for a page that is not drawn) and, while `drawn`, a canvas (rendered off screen and swapped in,
 * so a redraw never flashes), pdf.js's text layer (`data-selectable` comes from the reader's root)
 * and the page's links.
 */
export const PdfPage = memo(function PdfPage({
  doc,
  page,
  scale,
  width,
  height,
  top,
  left,
  drawn,
  onLayer,
  onGoToPage,
}: PageProps) {
  return (
    <div
      data-pdf-page={page}
      className="pdf-page"
      style={{ top, left, width, height, ["--total-scale-factor" as string]: scale }}
    >
      {drawn ? (
        <>
          <Canvas doc={doc} page={page} scale={scale} width={width} height={height} />
          <TextLayer doc={doc} page={page} scale={scale} onLayer={onLayer} />
          <Links doc={doc} page={page} scale={scale} onGoToPage={onGoToPage} />
        </>
      ) : null}
    </div>
  );
});

function Canvas({
  doc,
  page,
  scale,
  width,
  height,
}: {
  doc: PdfDocument;
  page: number;
  scale: number;
  width: number;
  height: number;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let task: { cancel(): void } | null = null;
    let live = true;
    const timer = setTimeout(() => {
      const canvas = document.createElement("canvas");
      canvas.style.cssText = "display:block;width:100%;height:100%";
      const render = doc.render(
        page,
        scale,
        canvas,
        outputScale(width, height, window.devicePixelRatio || 1),
      );
      task = render;
      render.promise.then(
        () => {
          if (live) el.replaceChildren(canvas);
        },
        (error: unknown) => {
          logger.warn(
            "pdf",
            `a page did not draw (${error instanceof Error ? error.name : "error"})`,
          );
        },
      );
    }, REDRAW_DELAY_MS);
    return () => {
      live = false;
      clearTimeout(timer);
      task?.cancel();
    };
    // width and height follow scale
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, page, scale]);
  return <div ref={host} data-pdf-canvas className="pdf-canvas" />;
}

function TextLayer({
  doc,
  page,
  scale,
  onLayer,
}: {
  doc: PdfDocument;
  page: number;
  scale: number;
  onLayer: PageProps["onLayer"];
}) {
  const host = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let live = true;
    let task: { cancel(): void } | null = null;
    const timer = setTimeout(() => {
      const layer = document.createElement("div");
      layer.className = "pdf-text-layer-body";
      const render = doc.renderText(page, scale, layer);
      task = render;
      render.promise.then(
        (handle) => {
          if (!live) return;
          el.replaceChildren(layer);
          onLayer(page, handle);
        },
        (error: unknown) => {
          logger.warn(
            "pdf",
            `text did not load (${error instanceof Error ? error.name : "error"})`,
          );
        },
      );
    }, REDRAW_DELAY_MS);
    return () => {
      live = false;
      clearTimeout(timer);
      task?.cancel();
      onLayer(page, null);
    };
  }, [doc, page, scale, onLayer]);
  return <div ref={host} data-pdf-text className="pdf-text-layer" />;
}

function Links({
  doc,
  page,
  scale,
  onGoToPage,
}: {
  doc: PdfDocument;
  page: number;
  scale: number;
  onGoToPage: (page: number) => void;
}) {
  const [links, setLinks] = useState<PdfLink[]>([]);
  useEffect(() => {
    let live = true;
    doc.links(page, scale).then(
      (found) => live && setLinks(found),
      () => live && setLinks([]),
    );
    return () => {
      live = false;
    };
  }, [doc, page, scale]);
  return (
    <>
      {links.map((link, i) => {
        const box = { left: link.x, top: link.y, width: link.width, height: link.height };
        return link.url ? (
          <button
            key={i}
            type="button"
            data-pdf-link="external"
            title={link.url}
            className="pdf-link"
            style={box}
            {...linkHandlers({ kind: "url", href: link.url })}
          />
        ) : (
          <button
            key={i}
            type="button"
            data-pdf-link="internal"
            title={`Page ${link.page}`}
            className="pdf-link"
            style={box}
            onClick={() => link.page && onGoToPage(link.page)}
          />
        );
      })}
    </>
  );
}
