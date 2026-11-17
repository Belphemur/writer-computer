import { EditorView } from "@codemirror/view";
import { type Extension, Prec } from "@codemirror/state";
import { openPath as openWithOs, openUrl } from "@tauri-apps/plugin-opener";
import * as editorApi from "@/hooks/editor-api";
import { getWorkspaceRoot } from "@/hooks/workspace-api";
import { buildSlugIndex, parseDocumentHeadings } from "@/hooks/use-document-headings";
import type { DocumentHeading } from "@/hooks/use-document-headings";
import {
  openPath,
  type LinkIntent,
  type LinkTarget,
  linkActivationExtension,
} from "@/lib/link-activation";
import { resolveLinkTarget } from "@/lib/paths";
import { setPendingAnchor } from "@/lib/pending-anchor";
import { linkUrlAt, rawUrlAt } from "@/lib/prosemark-core/links";
import * as tauri from "@/lib/tauri";
import { findOuterScroller, scrollPosToSafeTop } from "./editor-scroll";
import { showEditorNotice } from "./editor-notice-store";

export function findHeadingBySlug(content: string, slug: string): DocumentHeading | undefined {
  return buildSlugIndex(parseDocumentHeadings(content, { maxDepth: 6, slugDepth: 6 })).get(slug);
}

function scrollSameDocAnchor(view: EditorView, filePath: string, anchor: string) {
  const file = editorApi.getOpenFile(filePath);
  const content = file?.content ?? view.state.doc.toString();
  const heading = findHeadingBySlug(content, anchor);
  if (!heading) {
    showEditorNotice(`Heading "#${anchor}" not found in this document`);
    return;
  }
  const scroller = findOuterScroller(view.dom);
  if (!scroller) return;
  scrollPosToSafeTop(view, scroller, heading.pos, "smooth");
}

/** Navigate to `href` as written in the document: same-document anchors
 *  scroll, workspace files open in the tab (with a pending anchor), external
 *  URLs and other paths hand off to the OS. */
export async function followLink(
  href: string | null,
  view: EditorView,
  filePath: string,
  intent: LinkIntent = "current",
) {
  if (!href) return;

  const target = await resolveLinkTarget(href, filePath, getWorkspaceRoot(), (path) =>
    tauri.fileExists(path),
  );
  if (!target) return;

  if (target.kind === "same-doc-anchor") {
    scrollSameDocAnchor(view, filePath, target.anchor);
    return;
  }

  if (target.kind === "internal") {
    if (target.anchor && target.path === filePath) {
      scrollSameDocAnchor(view, filePath, target.anchor);
      return;
    }
    if (target.anchor) setPendingAnchor(target.path, target.anchor);
    await openPath(target.path, intent);
    return;
  }

  if (target.kind === "external-url") {
    await openUrl(target.url);
    return;
  }

  await openWithOs(target.path);
}

/** Link href under a document position, whether rendered or a bare URL. */
export function linkHrefAtPos(view: EditorView, pos: number): string | null {
  return linkUrlAt(view.state, pos) ?? rawUrlAt(view.state, pos) ?? null;
}

/** The href a rendered link element carries (`data-href`, set by table cells and other widgets
 *  that cannot be mapped back to a source position), if the element is inside one. */
export function renderedLinkHrefOf(el: Element): string | null {
  return el.closest<HTMLElement>(".cm-rendered-link")?.dataset.href ?? null;
}

/** Resolve the link href under a mouse event, or null if it isn't a link.
 *  Shared by the mousedown (claim the press) and click (navigate) handlers. */
function linkHrefAt(event: MouseEvent, view: EditorView): string | null {
  const target = event.target;
  if (!(target instanceof Element)) return null;

  const htmlAnchor = target.closest(".cm-html-block-widget a");
  if (htmlAnchor instanceof HTMLAnchorElement) {
    return htmlAnchor.getAttribute("href");
  }

  const renderedLink = target.closest(".cm-rendered-link");
  const isRenderedLink = renderedLink !== null;
  const isRawUrl = target.closest(".cm-url") !== null;
  if (!isRenderedLink && !isRawUrl) return null;

  const carried = renderedLinkHrefOf(target);
  if (carried) return carried;
  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
  if (pos === null) return null;
  return (isRenderedLink ? linkUrlAt(view.state, pos) : rawUrlAt(view.state, pos)) ?? null;
}

/** The target of a link `href` written in the document: the one way a rendered link opens, for
 *  the editor's own click handler and for rendered cells outside it (the fullscreen table). */
export function linkTargetFor(
  href: string,
  view: EditorView,
  getFilePath: () => string,
  isDisposed: () => boolean,
): LinkTarget {
  return {
    kind: "custom",
    open: (intent) =>
      void followLink(href, view, getFilePath(), intent).catch((error) => {
        if (!isDisposed()) console.error("[editor] Failed to open link:", error);
      }),
  };
}

/** Left, middle and Cmd/Ctrl clicks on a link in the document (`lib/link-activation.ts`): the
 *  press is claimed on mousedown so CodeMirror does not move the caret into the link (which would
 *  unfold a rendered link); the navigation follows on click. */
export function linkNavigationExtension(
  getFilePath: () => string,
  isDisposed: () => boolean,
): Extension {
  return Prec.highest(
    linkActivationExtension((event, view) => {
      const href = linkHrefAt(event, view);
      if (href === null) return null;
      return linkTargetFor(href, view, getFilePath, isDisposed);
    }),
  );
}
