// Markdown that still means something outside the vault: what a copy puts on the clipboard.
// Wiki links and vault-relative links point into the vault, so they become their display text;
// embeds (`![[...]]`) are dropped; external links stay. Code (fences and inline spans) is literal.
import { isExternalHref } from "./external-url";
import { parseWikiLink, wikiLinkScanner } from "./wiki-links";

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const CODE_SPAN = /(`+)(?!`)[\s\S]*?[^`]\1(?!`)/g;
const MD_LINK = /(?<!!)\[([^\]\n]*)\]\(\s*([^)\s]*)(?:\s+"[^"]*")?\s*\)/g;
const REMOVED = "\uE000";

/** What a `[[link]]` shows: its alias, else the note name (last path segment) and the heading
 *  (`Note > Heading`); a block id (`#^id`) is not shown. */
function wikiDisplay(inner: string): string {
  const link = parseWikiLink(inner);
  if (link.alias) return link.alias;
  const name = link.path.split("/").pop() ?? "";
  const heading = (link.fragment ?? "")
    .split("#")
    .filter((s) => s.trim() !== "" && !s.startsWith("^"))
    .pop();
  return name && heading ? `${name} > ${heading}` : name || heading || "";
}

function prose(text: string): string {
  return text
    .replace(wikiLinkScanner(), (_m, bang: string, inner: string) =>
      bang ? REMOVED : wikiDisplay(inner),
    )
    .replace(MD_LINK, (m, label: string, href: string) => (isExternalHref(href) ? m : label));
}

/** One line outside a fence: prose parts converted, inline code kept; null when it held only
 *  embeds. */
function convertLine(line: string): string | null {
  let out = "";
  let last = 0;
  for (const m of line.matchAll(CODE_SPAN)) {
    out += prose(line.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  out += prose(line.slice(last));
  if (!out.includes(REMOVED)) return out;
  // an embed leaves no double space; a line that held only embeds goes away
  const cleaned = out.replace(/[ \t]*\uE000[ \t]*/g, (m, offset: number) =>
    offset === 0 || offset + m.length === out.length ? "" : " ",
  );
  return cleaned.trim() === "" ? null : cleaned;
}

export function toPortableMarkdown(markdown: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  let dropped = false;
  for (const line of markdown.split("\n")) {
    const f = FENCE.exec(line)?.[1];
    if (fence) {
      out.push(line);
      if (f && f[0] === fence[0] && f.length >= fence.length && line.trim() === f) fence = null;
      continue;
    }
    if (f) {
      fence = f;
      out.push(line);
      continue;
    }
    const converted = convertLine(line);
    if (converted === null) {
      dropped = true;
      continue;
    }
    // dropping a line must not leave two blank lines side by side
    if (
      dropped &&
      converted.trim() === "" &&
      out.length > 0 &&
      out[out.length - 1]!.trim() === ""
    ) {
      dropped = false;
      continue;
    }
    dropped = false;
    out.push(converted);
  }
  return out.join("\n");
}
