// A picked icon (`emoji:<emoji>` or `icon:<Hugeicons name>`, `icon-value.ts`) drawn into a DOM
// element, for the places React does not render (a CodeMirror link or shortcode widget). The same
// look as `IconGlyph`: an emoji as text, an icon as an inline SVG in the text colour once its
// shard has loaded. Light: the icon data stays in the shards (`icon-set.ts`).
import type { IconSvgElement } from "@hugeicons/react";
import { loadHugeicon } from "./icon-set";
import { parseIconValue } from "./icon-value";

const SVG_NS = "http://www.w3.org/2000/svg";

const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** A glyph size: pixels, or a CSS length (`1.3em`) that follows the surrounding text. */
export type IconSize = number | string;

/** An `<svg>` of a Hugeicons icon (its attributes are camelCase React props). */
export function svgFromIcon(icon: IconSvgElement, size: IconSize): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("aria-hidden", "true");
  for (const [tag, attrs] of icon) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key !== "key") node.setAttribute(kebab(key), String(value));
    }
    svg.append(node);
  }
  return svg;
}

/** Draw `value` (or nothing, hiding the element) into `el`, in `color` when given. Safe to call
 *  again with another value: a slow shard never overwrites a newer icon. */
export function fillIconElement(
  el: HTMLElement,
  value: string | null | undefined,
  options: { size?: IconSize; color?: string } = {},
): void {
  const size = options.size ?? 14;
  const parsed = parseIconValue(value);
  el.dataset.iconValue = parsed ? `${parsed.kind}:${parsed.name}` : "";
  el.replaceChildren();
  el.style.display = parsed ? "inline-flex" : "none";
  el.style.color = options.color ?? "";
  if (!parsed) return;
  if (parsed.kind === "emoji") {
    el.textContent = parsed.name;
    // an emoji's glyph is wider than its font size: 0.9 makes it fill the same box as an SVG
    el.style.fontSize = typeof size === "number" ? `${size * 0.9}px` : `calc(${size} * 0.9)`;
    return;
  }
  el.style.fontSize = "";
  const wanted = el.dataset.iconValue;
  void loadHugeicon(parsed.name).then((icon) => {
    if (icon && el.dataset.iconValue === wanted) el.replaceChildren(svgFromIcon(icon, size));
  });
}
