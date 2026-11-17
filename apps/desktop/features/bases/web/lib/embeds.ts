// Pure model of a base embedded in a note: what `![[x.base#View|alias]]` and a fenced `base`
// block mean. The editor widget (`web/embed-decorations.ts`) finds the ranges; this
// file decides what they are, so the grammar lives in one place.
import { parseWikiLink } from "@/lib/wiki-links";
import { isBasePath } from "@/lib/paths";

export type BaseEmbed =
  /** `![[x.base]]`: `target` is the link path (name or vault path), `view` the `#View` part. */
  | { kind: "file"; target: string; view?: string }
  /** A fenced `base` block: the YAML source. */
  | { kind: "block"; text: string };

/** The inner text of `![[...]]` as a base embed, or `null` when it names anything else. */
export function parseBaseEmbedTarget(inner: string): BaseEmbed | null {
  const link = parseWikiLink(inner);
  if (!link.path || !isBasePath(link.path)) return null;
  const view = link.fragment?.trim();
  return { kind: "file", target: link.path, ...(view ? { view } : {}) };
}

/** A whole line that is exactly one `![[...]]` embed of a base (surrounding blanks allowed). */
const EMBED_LINE = /^[ \t]*!\[\[([^\]\n]+)\]\][ \t]*$/;

export function parseBaseEmbedLine(text: string): BaseEmbed | null {
  const match = EMBED_LINE.exec(text);
  return match ? parseBaseEmbedTarget(match[1]!) : null;
}

/** Does the fence info string name a base block (```base, case-insensitive, nothing else)? */
export function isBaseFenceInfo(info: string): boolean {
  return info.trim().toLowerCase() === "base";
}

/** Stable identity of an embed (cache keys, widget equality). */
export function embedKey(embed: BaseEmbed): string {
  return embed.kind === "file"
    ? `file\0${embed.target}\0${embed.view ?? ""}`
    : `block\0${embed.text}`;
}
