/**
 * Where the composer's `/` and `@` menus open. A token starts at a trigger character that is at
 * the start of the text or right after whitespace or an opening bracket or quote, and runs over
 * non-whitespace characters; the menu is for the token the caret is in, anywhere in the text and
 * any number of times per message. `src/lib/foo`, URLs, `a@b.c` and `and/or` do not trigger (the
 * character before the trigger is a letter), nor does a `/usr/bin` style path (a second slash).
 */
export type TriggerChar = "/" | "@";

export type Trigger = {
  char: TriggerChar;
  /** Index of the trigger character. */
  start: number;
  /** End of the whole token (the caret may sit in its middle); a pick replaces start..end. */
  end: number;
  /** What was typed after the trigger character, up to the caret. */
  query: string;
  /** Only leading whitespace before it: Claude Code expands a `/name` only here. */
  atStart: boolean;
};

const OPENERS = new Set(["(", "[", "{", '"', "'", "`", "<"]);
const isSpace = (c: string) => /\s/.test(c);
/** Markdown emphasis marks (`**@Plan.md**`, `~~@Plan.md~~`): an `@` right after a run of them that
 *  itself starts at a token boundary still starts a mention. */
const MARKS = new Set(["*", "~"]);
function afterMarks(text: string, i: number): boolean {
  let j = i;
  while (j > 0 && MARKS.has(text[j - 1]!)) j--;
  if (j === i) return false;
  const before = j === 0 ? " " : text[j - 1]!;
  return isSpace(before) || OPENERS.has(before);
}

export function findTrigger(text: string, caret: number, composing = false): Trigger | null {
  if (composing || caret < 0 || caret > text.length) return null;
  const quoted = quotedMention(text, caret);
  if (quoted) return quoted;
  let i = caret;
  while (i > 0 && !isSpace(text[i - 1]!)) i--;
  // `i` is the first character of the token under (or ending at) the caret.
  let start = i;
  if (start < caret && OPENERS.has(text[start]!) && start + 1 <= caret) start++;
  else {
    let k = start;
    while (k < caret && MARKS.has(text[k]!)) k++;
    if (k > start && k < caret && text[k] === "@") start = k;
  }
  const char = text[start];
  if (start >= caret || (char !== "/" && char !== "@")) return null;
  let query = text.slice(start + 1, caret);
  if (char === "@" && query.startsWith('"')) query = query.slice(1).replace(/"$/, "");
  if (char === "/" && query.includes("/")) return null; // a path, not a command
  if (char === "@" && query.includes("@")) return null;
  let end = caret;
  while (end < text.length && !isSpace(text[end]!)) end++;
  return {
    char,
    start,
    end,
    query,
    atStart: text.slice(0, start).trim() === "",
  };
}

/** The caret is inside `@"multi word name"` (still open or already closed): the token is the
 *  whole quoted span, so editing a picked name with several words keeps the menu working. */
function quotedMention(text: string, caret: number): Trigger | null {
  const at = text.lastIndexOf('@"', caret - 1);
  if (at < 0) return null;
  const prev = at === 0 ? " " : text[at - 1]!;
  if (!(isSpace(prev) || OPENERS.has(prev) || afterMarks(text, at))) return null;
  const typed = text.slice(at + 2, caret);
  if (typed.includes('"') || typed.includes("\n")) return null;
  const close = text.indexOf('"', caret);
  const closed = close >= 0 && !text.slice(caret, close).includes("\n");
  let end = closed ? close + 1 : caret;
  if (!closed) while (end < text.length && !isSpace(text[end]!)) end++;
  return { char: "@", start: at, end, query: typed, atStart: text.slice(0, at).trim() === "" };
}

/** The text after replacing the token with `replacement` and a trailing space (reused when one
 *  follows), and where the caret goes: just after that space. */
export function applyTrigger(
  text: string,
  t: Pick<Trigger, "start" | "end">,
  replacement: string,
): { text: string; caret: number } {
  const after = text.slice(t.end);
  const head = `${text.slice(0, t.start)}${replacement} `;
  return {
    text: head + (after.startsWith(" ") ? after.slice(1) : after),
    caret: head.length,
  };
}

// ---------------------------------------------------------------------------------------------
// The same token rules, applied to a whole message (transcript rendering, the prompt builder)

/** A message cut into plain text and the `@mention` / `/skill` tokens the composer produces. */
export type MessageSegment =
  | { kind: "text"; text: string }
  /** `@path`, or `@"path with spaces"` (Claude Code's quoted form); `@activenote` has the path
   *  `activenote` and is rewritten at send time. */
  | { kind: "mention"; raw: string; path: string }
  | { kind: "slash"; raw: string; name: string; atStart: boolean };

// `*` and `~` close Markdown emphasis and strikethrough around a token (`**see @Plan.md**`)
const TRAILING = /[.,;:!?)\]}'"`>*~]+$/;
const SKILL_NAME = /^[A-Za-z0-9][\w:.-]*$/;

/**
 * Same start rule as {@link findTrigger} (text start, or after whitespace or an opening bracket
 * or quote), same run over non-whitespace, so what the composer menu treats as a token the
 * transcript and the prompt builder do too. A token ends before trailing punctuation
 * (`@Plan.md,`); `@"..."` runs to the closing quote on the same line. `/usr/bin`, `a@b.c` and
 * `src/lib/foo` are text. Concatenating every `raw`/`text` gives back the input.
 */
export function tokenizeMessage(text: string): MessageSegment[] {
  const out: MessageSegment[] = [];
  let plain = 0;
  const flush = (to: number) => {
    if (to > plain) out.push({ kind: "text", text: text.slice(plain, to) });
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    const prev = i === 0 ? " " : text[i - 1]!;
    const startsHere = isSpace(prev) || OPENERS.has(prev) || (c === "@" && afterMarks(text, i));
    if ((c !== "@" && c !== "/") || !startsHere) {
      i++;
      continue;
    }
    let end = i + 1;
    let quotedPath: string | null = null;
    if (c === "@" && text[i + 1] === '"') {
      const close = text.indexOf('"', i + 2);
      const inner = close > i + 2 ? text.slice(i + 2, close) : "";
      if (close > 0 && inner !== "" && !inner.includes("\n")) {
        quotedPath = inner;
        end = close + 1;
      }
    }
    if (quotedPath === null) {
      while (end < text.length && !isSpace(text[end]!)) end++;
      end = i + 1 + text.slice(i + 1, end).replace(TRAILING, "").length;
    }
    const raw = text.slice(i, end);
    const body = quotedPath ?? raw.slice(1);
    let seg: MessageSegment | null = null;
    if (c === "@" && body !== "" && (quotedPath !== null || !body.includes("@")))
      seg = { kind: "mention", raw, path: body };
    else if (c === "/" && SKILL_NAME.test(body))
      seg = { kind: "slash", raw, name: body, atStart: text.slice(0, i).trim() === "" };
    if (!seg) {
      i = Math.max(end, i + 1);
      continue;
    }
    flush(i);
    out.push(seg);
    plain = end;
    i = end;
  }
  flush(text.length);
  return out;
}
