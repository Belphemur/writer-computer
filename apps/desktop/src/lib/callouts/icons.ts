// Callout icons: small stroke icons drawn on a 24x24 grid, written for Writer (not copied from
// any icon pack or from Obsidian). Built with createElementNS, so there is no innerHTML, no
// external fetch and nothing for the app's CSP to block.
import DOMPurify from "dompurify";
import type { BuiltinCallout } from "./syntax";

const NS = "http://www.w3.org/2000/svg";

/** Path data per built-in type (each string is one `<path d>`). */
export const CALLOUT_ICON_PATHS: Record<BuiltinCallout, readonly string[]> = {
  note: ["M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19z", "M14 7l3 3"],
  abstract: [
    "M9 3.5h6v3H9z",
    "M9 5H6.5A1.5 1.5 0 0 0 5 6.5v13A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5v-13A1.5 1.5 0 0 0 17.5 5H15",
    "M8.5 11.5h7M8.5 15.5h5",
  ],
  info: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", "M12 11v5.5", "M12 7.8v.01"],
  todo: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", "M8 12.5l3 3 5-6"],
  tip: ["M12 3c1 3.5 5 5.5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 .5 1 1.2 1.6 2 1.8C11 8 11.5 5.5 12 3z"],
  success: ["M5 12.5l4.5 4.5L19 7.5"],
  question: [
    "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z",
    "M9.5 9.5a2.5 2.5 0 1 1 3.6 2.2c-.7.4-1.1 1-1.1 1.8",
    "M12 16.8v.01",
  ],
  warning: ["M12 4l9 15.5H3z", "M12 10v4", "M12 16.8v.01"],
  failure: ["M6 6l12 12", "M18 6L6 18"],
  danger: ["M13 3L5 13.5h6L10 21l8-10.5h-6z"],
  bug: [
    "M8.5 10a3.5 3.5 0 0 1 7 0v5a3.5 3.5 0 0 1-7 0z",
    "M9.5 5.5L8 3.5M14.5 5.5L16 3.5",
    "M5 9l3.5 1.5M19 9l-3.5 1.5M4 14h4.5M19.5 14h-4M6 20l3-2.5M18 20l-3-2.5",
  ],
  example: ["M9 6h11M9 12h11M9 18h11", "M4.5 6v.01M4.5 12v.01M4.5 18v.01"],
  quote: [
    "M10 7C7 8 6 10 6 13v4h5v-5H8c0-2 .8-3.3 2-4z",
    "M19 7c-3 1-4 3-4 6v4h5v-5h-3c0-2 .8-3.3 2-4z",
  ],
};

const CHEVRON_PATH = "M6 9l6 6 6-6";

/** Icon ids a `--callout-icon: lucide-<id>` value can name (Lucide-style names). */
const ICON_IDS: Record<string, BuiltinCallout> = {
  pencil: "note",
  "clipboard-list": "abstract",
  info: "info",
  "check-circle-2": "todo",
  "circle-check": "todo",
  flame: "tip",
  check: "success",
  "help-circle": "question",
  "circle-help": "question",
  "alert-triangle": "warning",
  "triangle-alert": "warning",
  x: "failure",
  zap: "danger",
  bug: "bug",
  list: "example",
  quote: "quote",
};

function svgRoot(doc: Document, className: string): SVGElement {
  const svg = doc.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("class", `svg-icon ${className}`);
  svg.setAttribute("aria-hidden", "true");
  return svg;
}

function withPaths(svg: SVGElement, paths: readonly string[]): SVGElement {
  for (const d of paths) {
    const path = svg.ownerDocument.createElementNS(NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

export function createCalloutIcon(doc: Document, kind: BuiltinCallout): SVGElement {
  return withPaths(svgRoot(doc, `callout-icon-${kind}`), CALLOUT_ICON_PATHS[kind]);
}

export function createCalloutChevron(doc: Document): SVGElement {
  return withPaths(svgRoot(doc, "callout-chevron"), [CHEVRON_PATH]);
}

export type CustomIcon = { kind: "builtin"; icon: BuiltinCallout } | { kind: "svg"; svg: string };

const MAX_SVG_CHARS = 8000;

/** Reads a `--callout-icon` value (as `getPropertyValue` returns it): a known icon id, or a
 *  quoted SVG string. Anything else is ignored. */
export function parseCustomIconValue(value: string): CustomIcon | null {
  let v = value.trim();
  if (!v) return null;
  const q = v[0];
  if ((q === "'" || q === '"') && v.endsWith(q) && v.length >= 2) v = v.slice(1, -1).trim();
  if (v.startsWith("<")) {
    return v.length <= MAX_SVG_CHARS && /^<svg[\s>]/i.test(v) ? { kind: "svg", svg: v } : null;
  }
  const id = v.replace(/^lucide-/, "");
  const icon = ICON_IDS[id];
  return icon ? { kind: "builtin", icon } : null;
}

// Its own DOMPurify instance (hooks other renderers add to the shared one must not apply here),
// created on first use because DOMPurify needs a window.
let purifier: ReturnType<typeof DOMPurify> | null = null;

/** Sanitised `<svg>` element from a user snippet's SVG string, or null. Scripts, styles,
 *  external references, `<use>` and event handlers never survive. */
export function sanitizeCustomSvg(doc: Document, svg: string): SVGElement | null {
  purifier ??= DOMPurify(window);
  const body = purifier.sanitize(svg, {
    USE_PROFILES: { svg: true },
    FORBID_TAGS: ["use", "image", "foreignObject", "a", "script", "style"],
    FORBID_ATTR: ["style", "href", "xlink:href"],
    RETURN_DOM: true,
  });
  const el = (body as unknown as Element).querySelector("svg");
  if (!el) return null;
  const clone = doc.importNode(el, true) as unknown as SVGElement;
  clone.setAttribute("class", "svg-icon");
  clone.setAttribute("aria-hidden", "true");
  return clone;
}
