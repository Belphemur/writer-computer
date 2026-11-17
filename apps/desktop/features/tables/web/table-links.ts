// The target of a rendered link inside a table cell that lives outside the editor's own DOM (the
// fullscreen overlay): the inline widget is covered by the editor's link extensions, this maps the
// same cell markup (`table-inline.ts`: `data-wiki-target`, `data-href`) onto the same two openers
// those extensions use, so a link opens identically wherever the cell is shown.
import type { EditorView } from "@codemirror/view";
import { linkTargetFor, renderedLinkHrefOf } from "@/components/editor-area/link-navigation";
import { wikiTargetOf } from "@/components/editor-area/wiki-link-extension";
import { editorNotePath } from "@/lib/editor-views";
import { isExternalHref } from "@/lib/external-url";
import { wikiLinkTarget, type LinkTarget } from "@/lib/link-activation";

export interface CellLink {
  target: LinkTarget;
  /** An http(s)/mailto URL: it opens in the system browser and leaves the note where it is. */
  external: boolean;
}

export function cellLinkAt(el: Element, view: EditorView): CellLink | null {
  const notePath = view.state.facet(editorNotePath);
  const isDisposed = () => !view.dom.isConnected;
  const wiki = wikiTargetOf(el);
  if (wiki) return { target: wikiLinkTarget(wiki, notePath, isDisposed), external: false };
  const href = renderedLinkHrefOf(el);
  if (!href) return null;
  return {
    target: linkTargetFor(href, view, notePath, isDisposed),
    external: isExternalHref(href),
  };
}
