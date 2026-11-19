// The ONLY module that imports pdf.js (a test pins that). It is loaded lazily, the first time a PDF
// tab or embed mounts or a PDF's pages are counted, and everything else in the feature talks to
// the small `PdfDocument` interface below, which tests replace with a fake.
//
// pdf.js runs its parser in a module worker served from the app bundle (`?url` emits the worker
// as an asset next to the other chunks: same origin, no CDN, `worker-src 'self'` already allows
// it). The PDF's bytes come from the Rust command `read_document`; this module never writes.
import {
  GlobalWorkerOptions,
  TextLayer,
  getDocument,
  type PDFDocumentProxy,
  type PDFPageProxy,
} from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { Size } from "@/lib/viewer-zoom";
import { PDFJS_DATA_URLS } from "./asset-urls";
import type { TextItem } from "./find";

GlobalWorkerOptions.workerSrc = workerUrl;

/** Work that can be abandoned: a render that scrolled out of range, a zoom that moved on. */
export interface Cancelable<T> {
  promise: Promise<T>;
  cancel(): void;
}

/** A link on a page, in CSS pixels of the page at the scale it was asked for. */
export interface PdfLink {
  x: number;
  y: number;
  width: number;
  height: number;
  /** An external address. */
  url?: string;
  /** The 1-based page an internal link jumps to. */
  page?: number;
}

/** What a rendered text layer exposes so find can mark it. */
export interface TextLayerHandle {
  /** The strings of the text items, in order. */
  items: string[];
  /** The element of each text item. */
  divs: HTMLElement[];
}

export interface PdfDocument {
  numPages: number;
  /** A page's size at scale 1 (rotation applied). */
  pageSize(page: number): Promise<Size>;
  /** Draw a page into `canvas` at `scale` (CSS pixels per PDF point) for a screen of `dpr`. */
  render(page: number, scale: number, canvas: HTMLCanvasElement, dpr: number): Cancelable<void>;
  /** Fill `container` with the page's selectable text. */
  renderText(page: number, scale: number, container: HTMLElement): Cancelable<TextLayerHandle>;
  /** The text of a page, for find. */
  textItems(page: number): Promise<TextItem[]>;
  /** The page's links at `scale`. */
  links(page: number, scale: number): Promise<PdfLink[]>;
  destroy(): void;
}

const isCancel = (e: unknown) => e instanceof Error && e.name === "RenderingCancelledException";

class Document implements PdfDocument {
  private pages = new Map<number, Promise<PDFPageProxy>>();

  constructor(private readonly doc: PDFDocumentProxy) {}

  get numPages(): number {
    return this.doc.numPages;
  }

  private page(n: number): Promise<PDFPageProxy> {
    let p = this.pages.get(n);
    if (!p) {
      p = this.doc.getPage(n);
      this.pages.set(n, p);
    }
    return p;
  }

  async pageSize(n: number): Promise<Size> {
    const v = (await this.page(n)).getViewport({ scale: 1 });
    return { width: v.width, height: v.height };
  }

  render(n: number, scale: number, canvas: HTMLCanvasElement, dpr: number): Cancelable<void> {
    let task: { cancel(): void } | null = null;
    let cancelled = false;
    const promise = this.page(n)
      .then((page) => {
        if (cancelled) return;
        const viewport = page.getViewport({ scale });
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        const render = page.render({
          canvas,
          viewport,
          transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0],
        });
        task = render;
        return render.promise;
      })
      .catch((e: unknown) => {
        if (!isCancel(e)) throw e;
      });
    return {
      promise,
      cancel: () => {
        cancelled = true;
        task?.cancel();
      },
    };
  }

  renderText(n: number, scale: number, container: HTMLElement): Cancelable<TextLayerHandle> {
    let layer: TextLayer | null = null;
    let cancelled = false;
    const promise = this.page(n).then(async (page) => {
      if (cancelled) return { items: [], divs: [] };
      layer = new TextLayer({
        textContentSource: page.streamTextContent(),
        container,
        viewport: page.getViewport({ scale }),
      });
      await layer.render();
      return { items: layer.textContentItemsStr, divs: layer.textDivs };
    });
    return {
      promise: promise.catch((e: unknown) => {
        if (cancelled || isCancel(e)) return { items: [], divs: [] };
        throw e;
      }),
      cancel: () => {
        cancelled = true;
        layer?.cancel();
      },
    };
  }

  async textItems(n: number): Promise<TextItem[]> {
    const content = await (await this.page(n)).getTextContent();
    return content.items.flatMap((item) =>
      "str" in item ? [{ str: item.str, hasEOL: item.hasEOL }] : [],
    );
  }

  async links(n: number, scale: number): Promise<PdfLink[]> {
    const page = await this.page(n);
    const viewport = page.getViewport({ scale });
    const out: PdfLink[] = [];
    for (const a of await page.getAnnotations()) {
      if (a.subtype !== "Link" || !Array.isArray(a.rect)) continue;
      const [x1, y1, x2, y2] = a.rect as number[];
      const [ax, ay] = viewport.convertToViewportPoint(x1!, y1!) as [number, number];
      const [bx, by] = viewport.convertToViewportPoint(x2!, y2!) as [number, number];
      const box = {
        x: Math.min(ax, bx),
        y: Math.min(ay, by),
        width: Math.abs(bx - ax),
        height: Math.abs(by - ay),
      };
      if (typeof a.url === "string" && a.url !== "") out.push({ ...box, url: a.url });
      else {
        const target = await this.pageOfDestination(a.dest);
        if (target !== null) out.push({ ...box, page: target });
      }
    }
    return out;
  }

  /** The 1-based page of an internal destination (a name or an explicit array), or null. */
  private async pageOfDestination(dest: unknown): Promise<number | null> {
    try {
      const explicit = typeof dest === "string" ? await this.doc.getDestination(dest) : dest;
      if (!Array.isArray(explicit) || explicit.length === 0) return null;
      const head = explicit[0] as unknown;
      if (typeof head === "number") return head + 1;
      return head && typeof head === "object"
        ? (await this.doc.getPageIndex(head as Parameters<PDFDocumentProxy["getPageIndex"]>[0])) + 1
        : null;
    } catch {
      return null;
    }
  }

  destroy(): void {
    this.pages.clear();
    void this.doc.loadingTask.destroy();
  }
}

/** Open a PDF from its bytes (the array is handed to the worker, so pass a copy you keep no use
 *  for). Rejects for bytes that are not a readable PDF, and for a PDF that asks for a password. */
export async function openDocument(data: Uint8Array): Promise<PdfDocument> {
  const task = getDocument({ data, ...PDFJS_DATA_URLS });
  try {
    return new Document(await task.promise);
  } catch (e) {
    void task.destroy();
    throw e;
  }
}
