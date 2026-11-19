// A PDF document without pdf.js: pages of known sizes and text, links, and a record of what was
// drawn, so the reader's behaviour (which pages draw, at what scale, find, links) is testable in
// jsdom, which has no canvas and no worker. `vi.mock("../web/lib/pdf-lib")` hands it to the views.
import type { PdfDocument, PdfLink, TextLayerHandle } from "../../web/lib/pdf-lib";

export interface FakeOptions {
  /** One entry per page: its text items (each a line). */
  text?: string[][];
  size?: { width: number; height: number };
  sizes?: { width: number; height: number }[];
  links?: Record<number, PdfLink[]>;
}

export interface FakeDoc extends PdfDocument {
  drawn: { page: number; scale: number }[];
  texted: { page: number; scale: number }[];
  cancelled: number;
  destroyed: boolean;
  /** Pages currently holding a canvas that finished (the last draw of each page). */
  lastScale(page: number): number | undefined;
}

export function fakeDoc(pages: number, options: FakeOptions = {}): FakeDoc {
  const size = options.size ?? { width: 600, height: 800 };
  const doc: FakeDoc = {
    numPages: pages,
    drawn: [],
    texted: [],
    cancelled: 0,
    destroyed: false,
    lastScale(page) {
      return [...doc.drawn].reverse().find((d) => d.page === page)?.scale;
    },
    async pageSize(page) {
      return options.sizes?.[page - 1] ?? size;
    },
    render(page, scale) {
      doc.drawn.push({ page, scale });
      return { promise: Promise.resolve(), cancel: () => void doc.cancelled++ };
    },
    renderText(page, scale, container): { promise: Promise<TextLayerHandle>; cancel(): void } {
      doc.texted.push({ page, scale });
      const items = options.text?.[page - 1] ?? [];
      const divs = items.map((s) => {
        const span = document.createElement("span");
        span.textContent = s;
        container.append(span);
        return span;
      });
      return { promise: Promise.resolve({ items, divs }), cancel: () => void doc.cancelled++ };
    },
    async textItems(page) {
      return (options.text?.[page - 1] ?? []).map((str) => ({ str, hasEOL: true }));
    },
    async links(page) {
      return options.links?.[page] ?? [];
    },
    destroy() {
      doc.destroyed = true;
    },
  };
  return doc;
}
