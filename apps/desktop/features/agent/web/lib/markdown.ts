/**
 * Assistant text -> sanitised HTML. The same pieces the plugin host and the README renderer use
 * (marked, then the shared strict DOMPurify allowlist in `lib/safe-html.ts`); the input is
 * untrusted model output. `[[wikilinks]]` become `#wikilink:<target>` anchors that the pane
 * resolves through the vault index on click; `http(s)`/`mailto` links open in the system browser.
 */
import { Marked } from "marked";
import { SAFE_ATTR, SAFE_TAGS, sanitizeHtml } from "@/lib/safe-html";

const MAX_CHARS = 200_000;
const URI_REGEXP = /^(?:(?:https?|mailto):|#)/i;
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
        const m = /^\[\[([^\]\n|]+?)(?:\|([^\]\n]+?))?\]\]/.exec(src);
        if (!m) return undefined;
        return { type: "wikilink", raw: m[0], target: m[1]!.trim(), label: (m[2] ?? m[1])!.trim() };
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

/** `breaks`: a single newline is a line break (the user's own messages, typed in a composer where
 *  Shift+Enter means "next line"); assistant text keeps CommonMark's soft breaks. */
export function renderAgentMarkdown(markdown: string, opts: { breaks?: boolean } = {}): string {
  const source = markdown.length > MAX_CHARS ? markdown.slice(0, MAX_CHARS) : markdown;
  const html = marked.parse(source, { async: false, breaks: opts.breaks ?? false });
  return sanitizeHtml(
    html,
    { tags: SAFE_TAGS, attrs: SAFE_ATTR.filter((a) => a !== "target"), uriRegexp: URI_REGEXP },
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
