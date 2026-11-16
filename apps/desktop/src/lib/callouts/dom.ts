// DOM side of callouts shared by the plugin markdown renderer and the editor: icon and chevron
// filling, the fold toggle for rendered callouts and custom `--callout-icon` resolution.
import {
  createCalloutChevron,
  createCalloutIcon,
  parseCustomIconValue,
  sanitizeCustomSvg,
} from "./icons";
import { resolveCalloutType } from "./syntax";

/** Fills the (empty) `.callout-icon` and `.callout-fold` placeholders of every callout under
 *  `root`. Creates elements itself, so it runs after sanitising. */
export function decorateRenderedCallouts(root: Element): void {
  for (const callout of root.querySelectorAll(".callout[data-callout]")) {
    const doc = callout.ownerDocument;
    const kind = resolveCalloutType(callout.getAttribute("data-callout") ?? "");
    for (const title of callout.children) {
      if (!title.classList.contains("callout-title")) continue;
      for (const part of title.children) {
        if (part.childElementCount > 0) continue;
        if (part.classList.contains("callout-icon")) part.append(createCalloutIcon(doc, kind));
        else if (part.classList.contains("callout-fold")) part.append(createCalloutChevron(doc));
      }
    }
  }
}

/** Click on a rendered callout's title folds or unfolds it (per render, not persisted).
 *  Returns true when the click was handled. */
export function toggleRenderedCallout(target: Element | null, root: Element): boolean {
  if (!target || target.closest("a")) return false;
  const title = target.closest(".callout-title");
  const callout = title?.parentElement;
  if (!title || !callout || !root.contains(callout)) return false;
  if (!callout.classList.contains("is-collapsible")) return false;
  const collapsed = callout.classList.toggle("is-collapsed");
  for (const fold of title.querySelectorAll(".callout-fold")) {
    fold.classList.toggle("is-collapsed", collapsed);
  }
  return true;
}

/** `--callout-icon` per icon element under `root`, read from computed style. Needs a connected
 *  element; a detached tree keeps its default icons. A read (layout) step: do it in a measure
 *  phase. */
export function readCustomCalloutIcons(root: Element): [Element, string][] {
  if (!root.isConnected) return [];
  const bySource = new Map<Element, string>();
  const out: [Element, string][] = [];
  for (const icon of root.querySelectorAll(".callout-icon")) {
    const source = icon.closest("[data-callout]");
    if (!source) continue;
    let value = bySource.get(source);
    if (value === undefined) {
      value = getComputedStyle(source).getPropertyValue("--callout-icon");
      bySource.set(source, value);
    }
    out.push([icon, value.trim()]);
  }
  return out;
}

/** Swaps icons whose `--callout-icon` value changed. Idempotent per element and value. */
export function applyCustomCalloutIcons(icons: readonly [Element, string][]): void {
  for (const [icon, value] of icons) {
    const previous = icon.getAttribute("data-icon-spec") ?? "";
    if (previous === value) continue;
    const doc = icon.ownerDocument;
    const parsed = parseCustomIconValue(value);
    const source = icon.closest("[data-callout]");
    const kind = resolveCalloutType(source?.getAttribute("data-callout") ?? "");
    let next: Element | null = null;
    if (parsed?.kind === "builtin") next = createCalloutIcon(doc, parsed.icon);
    else if (parsed?.kind === "svg") next = sanitizeCustomSvg(doc, parsed.svg);
    icon.replaceChildren(next ?? createCalloutIcon(doc, kind));
    if (value) icon.setAttribute("data-icon-spec", value);
    else icon.removeAttribute("data-icon-spec");
  }
}
