import DOMPurify from "dompurify";
import { Marked } from "marked";

/** READMEs above this many characters are cut before parsing. */
export const README_MAX_CHARS = 500_000;

export const README_TRUNCATED_NOTE = '<p class="readme-truncated"><em>README truncated.</em></p>';

/** The only elements a README may produce. No script, style, iframe, object, embed, form, input,
 *  svg, math, link, meta or base. */
export const ALLOWED_TAGS = [
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
export const ALLOWED_ATTR = [
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

// DOMPurify's default URI allowlist narrowed to http(s), mailto and tel (relative URLs pass and
// are resolved or dropped below). `javascript:`, `data:`, `vbscript:`, `blob:`, `file:` fail.
const URI_REGEXP = /^(?:(?:https?|mailto|tel):|[^a-z]|[a-z+.-]+(?:[^a-z+.:-]|$))/i;
const ABSOLUTE = /^(?:https?|mailto|tel):/i;
const REPO = /^[\w.-]+\/[\w.-]+$/;

function resolveRelative(value: string, repo: string | undefined, kind: "raw" | "blob") {
  if (!repo || !REPO.test(repo)) return null;
  if (value.startsWith("//")) return null;
  const base =
    kind === "raw"
      ? `https://raw.githubusercontent.com/${repo}/HEAD/`
      : `https://github.com/${repo}/blob/HEAD/`;
  try {
    const url = new URL(value.replace(/^\/+/, ""), base);
    return url.href.startsWith(base) ? url.href : null;
  } catch {
    return null;
  }
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

const marked = new Marked({
  gfm: true,
  renderer: {
    // Task-list checkboxes would be <input>; render static glyphs instead.
    checkbox: ({ checked }: { checked: boolean }) => (checked ? "☑ " : "☐ "),
  },
});

/** Markdown (or raw HTML) README -> sanitized HTML safe for innerHTML. `repo` is the catalog's
 *  `owner/name`; relative URLs resolve against it (GitHub only) and are dropped otherwise. */
export function renderReadme(markdown: string, opts: { repo?: string } = {}): string {
  const truncated = markdown.length > README_MAX_CHARS;
  const source = truncated ? markdown.slice(0, README_MAX_CHARS) : markdown;
  const html = marked.parse(source, { async: false });

  const hook = (node: Element) => {
    if (node instanceof HTMLAnchorElement || node.tagName === "A") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer nofollow");
    }
    for (const attr of ["href", "src"] as const) {
      const value = node.getAttribute(attr);
      if (value === null) continue;
      const v = value.trim();
      const isImg = node.tagName === "IMG";
      if (attr === "href" && node.tagName !== "A") node.removeAttribute(attr);
      else if (attr === "src" && !isImg) node.removeAttribute(attr);
      else if (ABSOLUTE.test(v)) {
        // Images are fetched by the webview: http(s) only.
        if (isImg && !/^https?:/i.test(v)) node.removeAttribute(attr);
        else node.setAttribute(attr, v);
      } else if (v.startsWith("#") && !isImg) node.setAttribute(attr, v);
      else {
        const resolved = resolveRelative(v, opts.repo, isImg ? "raw" : "blob");
        if (resolved) node.setAttribute(attr, resolved);
        else node.removeAttribute(attr);
      }
    }
    if (/^H[1-6]$/.test(node.tagName)) {
      const id = slug(node.textContent ?? "");
      if (id) node.setAttribute("id", `readme-${id}`);
    }
  };

  DOMPurify.addHook("afterSanitizeAttributes", hook);
  try {
    const clean = DOMPurify.sanitize(html, {
      ALLOWED_TAGS,
      ALLOWED_ATTR,
      ALLOWED_URI_REGEXP: URI_REGEXP,
      ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: false,
      ALLOW_UNKNOWN_PROTOCOLS: false,
    });
    return truncated ? clean + README_TRUNCATED_NOTE : clean;
  } finally {
    DOMPurify.removeHook("afterSanitizeAttributes", hook);
  }
}
