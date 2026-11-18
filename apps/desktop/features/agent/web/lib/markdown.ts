/**
 * Assistant text -> sanitised HTML. The same pieces the plugin host and the README renderer use
 * (marked, then the shared strict DOMPurify allowlist in `lib/safe-html.ts`); the input is
 * untrusted model output. `[[wikilinks]]` become `#wikilink:<target>` anchors that the pane
 * resolves through the vault index on click; `http(s)`/`mailto` links open in the system browser.
 */
import { Lexer, Marked, Parser } from "marked";
import { externalOrAnchorUriRegExp } from "@/lib/external-url";
import { SAFE_ATTR, SAFE_TAGS, sanitizeHtml } from "@/lib/safe-html";
import { matchWikiLinkAtStart, parseWikiLink } from "@/lib/wiki-links";

const MAX_CHARS = 200_000;
const URI_REGEXP = externalOrAnchorUriRegExp();
export const WIKILINK_PREFIX = "#wikilink:";

const escapeAttr = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeText = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const marked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    // Raw HTML in model output is escaped, never passed through.
    html: ({ text }: { text: string }) => escapeText(text),
    checkbox: ({ checked }: { checked: boolean }) => (checked ? "☑ " : "☐ "),
    image: ({ text }: { text: string }) => escapeText(text),
  },
  extensions: [
    {
      name: "wikilink",
      level: "inline",
      start: (src: string) => src.indexOf("[["),
      tokenizer(src: string) {
        // The target keeps its `#heading`: the pane opens it like the editor's link does.
        const m = matchWikiLinkAtStart(src);
        if (!m) return undefined;
        const { target, alias } = parseWikiLink(m.inner);
        return { type: "wikilink", raw: m.raw, target, label: alias ?? target };
      },
      renderer(token) {
        const t = token as unknown as { target: string; label: string };
        return `<a href="${WIKILINK_PREFIX}${escapeAttr(encodeURIComponent(t.target))}">${escapeText(t.label)}</a>`;
      },
    },
  ],
});

function hook(node: Element) {
  if (node.tagName === "A") {
    node.setAttribute("rel", "noopener noreferrer nofollow");
    node.removeAttribute("target");
  } else {
    node.removeAttribute("href");
  }
  if (node.tagName === "IMG") node.remove();
}

/** Where a rendered top-level block came from: `data-md="start-end"`, character offsets in the
 *  source (`sourceOffset` maps them when the rendered text was a transformed copy of it). The
 *  selection copy reads them to give back the exact Markdown of the blocks a selection covers. */
export const MD_RANGE_ATTR = "data-md";
// The value is `#start-end`: the sanitiser only lets a value through that matches the URI
// allowlist (which accepts `#...`), whatever the attribute is.
export const mdRange = (start: number, end: number) => `#${start}-${end}`;
export const parseMdRange = (value: string): [number, number] =>
  value.slice(1).split("-").map(Number) as [number, number];

/** `breaks`: a single newline is a line break (the user's own messages, typed in a composer where
 *  Shift+Enter means "next line"); assistant text keeps CommonMark's soft breaks. */
export function renderAgentMarkdown(
  markdown: string,
  opts: { breaks?: boolean; sourceOffset?: (offset: number) => number } = {},
): string {
  const source = markdown.length > MAX_CHARS ? markdown.slice(0, MAX_CHARS) : markdown;
  const breaks = opts.breaks ?? false;
  const map = opts.sourceOffset ?? ((n: number) => n);
  // the static lexer and parser take the instance's options (renderer, extensions) explicitly
  const options = { ...marked.defaults, breaks, async: false as const };
  const tokens = Lexer.lex(source, options);
  // one pass per top-level token (the same output as one pass over all) to stamp its range
  let html = "";
  let pos = 0;
  for (const token of tokens) {
    const out = Parser.parse([token], options);
    const range = mdRange(map(pos), map(pos + token.raw.trimEnd().length));
    pos += token.raw.length;
    html +=
      token.type === "space"
        ? out
        : out.replace(/^<([a-z][a-z0-9]*)/, `<$1 ${MD_RANGE_ATTR}="${range}"`);
  }
  if (pos !== source.length) html = marked.parse(source, { async: false, breaks }) as string;
  return sanitizeHtml(
    html,
    {
      tags: SAFE_TAGS,
      attrs: [...SAFE_ATTR.filter((a) => a !== "target"), MD_RANGE_ATTR],
      uriRegexp: URI_REGEXP,
    },
    hook,
  );
}

/** `[[Note]]` target from an anchor href, or null for any other link. */
export function wikilinkTarget(href: string | null): string | null {
  if (!href?.startsWith(WIKILINK_PREFIX)) return null;
  try {
    return decodeURIComponent(href.slice(WIKILINK_PREFIX.length));
  } catch {
    return null;
  }
}
