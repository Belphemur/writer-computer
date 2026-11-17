/**
 * The one function that builds the prompt Claude receives (spec "What Writer sends"): the user's
 * text with each `@` reference kept inline in Claude Code's own syntax, then a compact
 * `<references>` block that ties the attached context to those tokens. Pure and golden-tested
 * (`shared/agent-prompt-golden.json`, also read by the Rust encoder test); the agent store sends
 * its result as `agent_send.text` and a "Preview exact text" view would show the same string.
 */
import type { ContextRef } from "./events";
import { isActiveNoteToken, mentionToken } from "./mentions";
import { openTabsBlock, type OpenTab } from "./open-tabs";
import { tokenizeMessage } from "./trigger";

export function contextRefLabel(ref: ContextRef): string {
  switch (ref.kind) {
    case "active-note":
    case "note":
    case "folder":
      return ref.path;
    case "selection":
      return `${ref.path}:${ref.fromLine}-${ref.toLine}`;
    case "tag":
      return `#${ref.tag.replace(/^#/, "")}`;
    case "property":
      return ref.value === null ? ref.name : `${ref.name}: ${ref.value}`;
    case "image":
    case "project-instructions":
      return ref.path;
    case "project-source":
      return ref.source.raw;
  }
}

/** Rough size estimate: ceil(chars / 4), shown with "~", never as exact. */
export const estimateTokens = (chars: number): number => Math.ceil(chars / 4);

/** `path` (vault-relative) as the claude process sees it: relative to its cwd, which is the
 *  vault root or the chat's project folder. A path outside the project climbs with `../`
 *  (the vault root is an `--add-dir`), so an absolute home path is never sent. */
export function relativeToCwd(path: string, cwd: string | null): string {
  if (path.startsWith("/")) return path;
  const base = (cwd ?? "").split("/").filter(Boolean);
  const parts = path.split("/").filter(Boolean);
  let common = 0;
  while (common < base.length && common < parts.length && base[common] === parts[common]) common++;
  const out = [...Array<string>(base.length - common).fill(".."), ...parts.slice(common)].join("/");
  return out === "" ? "." : out;
}

export type PromptInput = {
  /** What the user typed (and what the transcript and the chat note keep). */
  text: string;
  refs: readonly ContextRef[];
  /** The chat's project folder (vault-relative), null at the vault root. */
  cwd: string | null;
  /** Skill names known for this chat; a `/name` in the middle of the text gets a line. */
  skills?: readonly string[];
  /** Editor tabs to report in an `<open-tabs>` footer (the store passes none when unchanged). */
  openTabs?: readonly OpenTab[];
};

const REFERENCES_HEADER =
  "Attached by the user, paths relative to the working directory (read them with the Read tool when relevant):";

/**
 * Text sent to claude. Without a reference worth reporting it is `text` unchanged.
 *
 * - A token that matches an attached note or folder (by the readable label its pick put in the
 *   text, or by path) is rewritten to the note's full path in the cwd-relative form Claude Code resolves itself (quoted when it has spaces); it is expanded by
 *   the CLI (verified: file contents, folder listing). `@activenote` becomes the active note's
 *   path, resolved now from `refs` (no active-note ref: it stays literal and has no entry).
 * - Then, unless the text starts with a `/command` (Claude Code expands it only at the very
 *   start, and a block after it would become its arguments), a `<references>` block lists every
 *   attached ref once by the same token, with its kind. Nothing is inlined except a selection's
 *   quoted text. A mid-message `/skill` that is a known skill gets a line (the CLI does not
 *   expand it there).
 * - Then, with `openTabs`, an `<open-tabs>` block (see `open-tabs.ts`) under the same
 *   leading-command rule.
 */
export function buildPrompt({ text, refs, cwd, skills = [], openTabs = [] }: PromptInput): string {
  const sentToken = (path: string) => mentionToken(relativeToCwd(path, cwd));
  const tokenFor = new Map<string, string>();
  const entries = new Map<string, string>();
  let activeToken: string | null = null;
  const add = (key: string, line: string) => {
    if (!entries.has(key)) entries.set(key, line);
  };
  for (const r of refs) {
    switch (r.kind) {
      case "active-note": {
        const token = sentToken(r.path);
        activeToken ??= token;
        tokenFor.set(r.path, token);
        add(token, `- ${token} (active note: the note open in Writer)`);
        break;
      }
      case "note":
      case "folder": {
        const token = sentToken(r.path);
        // the token the pick put in the text (its readable label) and the plain path both map
        // to this ref; the label is never guessed from other refs
        if (r.label) tokenFor.set(r.label, token);
        if (!tokenFor.has(r.path)) tokenFor.set(r.path, token);
        add(token, `- ${token} (${r.kind})`);
        break;
      }
      case "selection": {
        const token = sentToken(r.path);
        const quoted = r.text.split("\n").map((l) => `  ${l}`);
        add(
          `selection:${token}:${r.fromLine}-${r.toLine}`,
          [`- selection in ${token}, lines ${r.fromLine}-${r.toLine}:`, ...quoted].join("\n"),
        );
        break;
      }
      case "image": {
        // sent natively as an image block too; the line is how the model (and a later turn, which
        // no longer carries the pixels) can name and re-read the file
        const token = sentToken(r.path);
        add(`image:${token}`, `- ${token} (image, also attached to this message)`);
        break;
      }
      case "tag": {
        const tag = `#${r.tag.replace(/^#/, "")}`;
        add(`tag:${tag}`, `- ${tag} (notes with this tag)`);
        break;
      }
      case "property":
        add(`property:${contextRefLabel(r)}`, `- ${contextRefLabel(r)} (notes with this property)`);
        break;
      default:
        break; // project instructions and sources are attached by the system, not per message
    }
  }

  const known = new Set(skills.map((s) => s.toLowerCase()));
  const segments = tokenizeMessage(text);
  let leadingCommand = false;
  const sent = segments
    .map((seg) => {
      if (seg.kind === "slash") {
        if (seg.atStart) leadingCommand = true;
        else if (known.has(seg.name.toLowerCase()))
          add(
            `skill:${seg.name.toLowerCase()}`,
            `- /${seg.name} (skill, not expanded mid-message: invoke it with the Skill tool)`,
          );
        return seg.raw;
      }
      if (seg.kind === "text") return seg.text;
      if (isActiveNoteToken(seg)) return activeToken ?? seg.raw;
      return tokenFor.get(seg.path) ?? tokenFor.get(seg.path.replace(/\/$/, "")) ?? seg.raw;
    })
    .join("");

  if (leadingCommand) return sent;
  const blocks: string[] = [];
  if (entries.size > 0)
    blocks.push(
      `<references>\n${REFERENCES_HEADER}\n${[...entries.values()].join("\n")}\n</references>`,
    );
  const tabsBlock = openTabsBlock(openTabs);
  if (tabsBlock) blocks.push(tabsBlock);
  return blocks.length === 0 ? sent : `${sent}\n\n${blocks.join("\n\n")}`;
}
