// What a click on an element's link does in a drawing (Excalidraw's `onLinkOpen`): it goes through
// Writer's link handling (`lib/link-activation.ts`, SPECs/link-activation-spec.md), never through
// Excalidraw's own `window.open`, which would navigate the webview. `[[Note]]`, `[[Note|alias]]`
// and `[[Note#heading]]` resolve like any vault link against the drawing's path; `http(s)` goes to
// the system browser; any other scheme is ignored.
import { activateLink, linkIntent, wikiLinkTarget, type LinkIntent } from "@/lib/link-activation";
import { isWikiLink, wikiLinkInner } from "@/lib/wiki-links";

/** The gesture behind the link click (a left, middle or Cmd/Ctrl click), "current" without one. */
export function elementLinkIntent(detail: unknown): LinkIntent {
  const native = (detail as { nativeEvent?: MouseEvent } | null)?.nativeEvent;
  return (native && linkIntent(native)) || "current";
}

export interface ElementLinkOptions {
  /** Called before a vault link opens in the current tab or an active new one, so a full screen
   *  closes first and is not left covering what was opened. */
  beforeVaultOpen?: () => void;
}

/** Open `link` from the drawing at `drawingPath`. Returns false for a link that is not opened. */
export function openElementLink(
  link: string,
  drawingPath: string,
  intent: LinkIntent,
  options: ElementLinkOptions = {},
): boolean {
  const text = link.trim();
  if (isWikiLink(text)) {
    const target = wikiLinkTarget(wikiLinkInner(text), () => drawingPath);
    activateLink(
      {
        kind: "custom",
        open: (i) => {
          if (i !== "new-tab-background") options.beforeVaultOpen?.();
          activateLink(target, i);
        },
      },
      intent,
    );
    return true;
  }
  if (/^https?:\/\//i.test(text)) {
    activateLink({ kind: "url", href: text }, intent);
    return true;
  }
  return false;
}
