import DOMPurify from "dompurify";

/** Shared DOMPurify core: one place for the strict element/attribute allowlist and the
 *  add-hook / sanitize / remove-hook dance. Callers (the plugin-browser README renderer, the
 *  Obsidian-plugin markdown renderer) pass their own config and per-node hook. */

/** The only elements untrusted markdown may produce by default. No script, style, iframe,
 *  object, embed, form, input, svg, math, link, meta or base. */
export const SAFE_TAGS = [
  "a",
  "abbr",
  "b",
  "blockquote",
  "br",
  "code",
  "dd",
  "del",
  "details",
  "div",
  "dl",
  "dt",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "kbd",
  "li",
  "ol",
  "p",
  "pre",
  "s",
  "span",
  "strong",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
];

/** No `style`, no `on*`, no `id`/`class`/`name` (page-level DOM clobbering). */
export const SAFE_ATTR = [
  "href",
  "src",
  "alt",
  "title",
  "align",
  "width",
  "height",
  "colspan",
  "rowspan",
  "open",
  "start",
  "rel",
  "target",
];

export interface SanitizeConfig {
  tags: readonly string[];
  attrs: readonly string[];
  uriRegexp: RegExp;
}

/** Sanitizes `html`; `hook` runs on every surviving node (after attribute filtering). */
export function sanitizeHtml(
  html: string,
  config: SanitizeConfig,
  hook: (node: Element) => void,
): string {
  DOMPurify.addHook("afterSanitizeAttributes", hook);
  try {
    return DOMPurify.sanitize(html, {
      ALLOWED_TAGS: [...config.tags],
      ALLOWED_ATTR: [...config.attrs],
      ALLOWED_URI_REGEXP: config.uriRegexp,
      ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: false,
      ALLOW_UNKNOWN_PROTOCOLS: false,
    });
  } finally {
    DOMPurify.removeHook("afterSanitizeAttributes", hook);
  }
}
