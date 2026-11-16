// Obsidian callout syntax (public help page "Callouts"): `> [!type]+ Title`. The one place that
// knows the type table and the header grammar; the editor decorations and the plugin markdown
// renderer both call it.

/** Built-in types and their aliases, from the public page. */
export const BUILTIN_CALLOUTS = {
  note: [],
  abstract: ["summary", "tldr"],
  info: [],
  todo: [],
  tip: ["hint", "important"],
  success: ["check", "done"],
  question: ["help", "faq"],
  warning: ["caution", "attention"],
  failure: ["fail", "missing"],
  danger: ["error"],
  bug: [],
  example: [],
  quote: ["cite"],
} as const satisfies Record<string, readonly string[]>;

export type BuiltinCallout = keyof typeof BUILTIN_CALLOUTS;

const ALIASES = new Map<string, BuiltinCallout>();
for (const [kind, aliases] of Object.entries(BUILTIN_CALLOUTS) as [
  BuiltinCallout,
  readonly string[],
][]) {
  ALIASES.set(kind, kind);
  for (const alias of aliases) ALIASES.set(alias, kind);
}

/** True for a built-in type or one of its aliases (case-insensitive). */
export function isKnownCalloutType(type: string): boolean {
  return ALIASES.has(type.toLowerCase());
}

/** Canonical built-in for a typed name; unknown types use the `note` look. */
export function resolveCalloutType(type: string): BuiltinCallout {
  return ALIASES.get(type.toLowerCase()) ?? "note";
}

/** Title shown when none was typed: the type name as typed, first letter capitalised. */
export function defaultCalloutTitle(type: string): string {
  return type.charAt(0).toUpperCase() + type.slice(1);
}

/** `""` not foldable, `"+"` foldable and open by default, `"-"` foldable and collapsed. */
export type CalloutFold = "" | "+" | "-";

export interface CalloutHeader {
  /** The type as typed, lowercased (`data-callout`). */
  type: string;
  /** Canonical built-in used for the icon and colour. */
  kind: BuiltinCallout;
  /** Text after `|` inside the brackets (`[!note|nomargin]`), else "". */
  metadata: string;
  fold: CalloutFold;
  /** Title text with trailing whitespace trimmed; "" when none was typed. */
  title: string;
  /** Offset in the header text where the title starts (after the marker and its spaces). */
  titleOffset: number;
}

// `[!type]`, optional `|metadata`, optional fold sign, then end of line or whitespace. A title
// glued to the bracket (`[!note]Title`) is not a callout.
const HEADER = /^\[!([^\]\s|]+)(?:\|([^\]\n]*))?\]([+-])?(?=[ \t]|$)[ \t]*(.*)$/;

/** Parses the first line of a quote's content (text from `[` to the end of the line). */
export function parseCalloutHeader(text: string): CalloutHeader | null {
  const m = HEADER.exec(text);
  if (!m) return null;
  const type = m[1]!.toLowerCase();
  return {
    type,
    kind: resolveCalloutType(type),
    metadata: m[2] ?? "",
    fold: (m[3] ?? "") as CalloutFold,
    title: m[4]!.trimEnd(),
    titleOffset: m[0].length - m[4]!.length,
  };
}
