// A picked icon as one string: `emoji:<emoji>` or `icon:<Hugeicons export name>`. The one parser
// and formatter of the picker, of the enum value icons and of everything that draws them; the
// Rust validator (`property_types.rs`, `valid_icon`) is its twin and both tests read
// `shared/icon-value-vectors.json`. Pure and light (no icon data).

export type IconKind = "emoji" | "icon";

export interface ParsedIcon {
  kind: IconKind;
  /** The emoji, or the Hugeicons export name. */
  name: string;
}

export const MAX_ICON_NAME = 64;
const ICON_NAME = /^[A-Z][A-Za-z0-9]*Icon$/;
const EMOJI_MARK = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u;
// `Intl.Segmenter` is in every supported webview; the app's TS `lib` predates its typings.
const segmenter = new (
  Intl as unknown as {
    Segmenter: new (
      locale: undefined,
      options: { granularity: "grapheme" },
    ) => { segment: (text: string) => Iterable<unknown> };
  }
).Segmenter(undefined, { granularity: "grapheme" });

/** Whether `text` is exactly one emoji (one grapheme that holds an emoji; plain text, digits and
 *  two emoji are not). */
export function isEmoji(text: string): boolean {
  if (text === "" || !EMOJI_MARK.test(text)) return false;
  const parts = segmenter.segment(text)[Symbol.iterator]();
  parts.next();
  return parts.next().done === true;
}

export function isIconName(name: string): boolean {
  return name.length <= MAX_ICON_NAME && ICON_NAME.test(name);
}

export function iconValue(kind: IconKind, name: string): string {
  return `${kind}:${name}`;
}

/** The icon a stored value names, or null when it is none (a bad prefix or shape). */
export function parseIconValue(value: string | null | undefined): ParsedIcon | null {
  if (!value) return null;
  const at = value.indexOf(":");
  const kind = value.slice(0, at);
  const name = value.slice(at + 1);
  if (kind === "emoji" && isEmoji(name)) return { kind, name };
  if (kind === "icon" && isIconName(name)) return { kind, name };
  return null;
}
