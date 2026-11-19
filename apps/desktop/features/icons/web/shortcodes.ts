// Inline icon shortcodes in a note (Iconize's `:` identifier): `:Rocket01Icon:` (a Hugeicons name)
// and `:rocket:` (an emoji name, words joined with `_`) render as the icon while the caret is
// elsewhere; the text stays in the file and shows again under the caret. After `:` and two
// letters the editor offers matching emoji and icons (the completion joins the editor's one
// autocompletion through `lib/editor-completion-sources.ts`). Spec `SPECs/icons-spec.md`.
import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { type Extension, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { isInsideCode } from "@/components/editor-area/wiki-link-extension";
import { getEffectiveSelectionRanges } from "@/components/editor-area/drag-selection-gate";
import { completionSources } from "@/lib/editor-completion-sources";
import { buildEmojiIndex, loadEmoji, searchEmojiIndex } from "@/lib/icon-picker/emoji-search";
import { fillIconElement } from "@/lib/icon-picker/icon-dom";
import {
  buildIconIndex,
  searchIconIndex,
  type IconIndexEntry,
} from "@/lib/icon-picker/icon-search";
import { loadIconSet } from "@/lib/icon-picker/icon-set";
import { iconValue, isIconName } from "@/lib/icon-picker/icon-value";
import { renderedRanges, renderedRangesChanged } from "@/lib/prosemark-core/utils";

const GLYPH_SIZE = 16;
const SHORTCODE = /:([A-Za-z0-9_+-]{2,}):/g;
/** `:` and at least two characters after it, up to the caret. */
const TRIGGER = /:[A-Za-z0-9_+-]{2,}$/;
const MAX_PER_KIND = 8;

/** `grinning face` -> `grinning_face`. */
export function emojiShortcode(name: string): string {
  return name
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .join("_");
}

/** The icon value a shortcode body names (`Rocket01Icon`, `rocket`), or null for anything else
 *  (a time such as `12:30:45` holds none). `emojis` maps shortcode to emoji. */
export function shortcodeValue(body: string, emojis: ReadonlyMap<string, string>): string | null {
  if (isIconName(body)) return iconValue("icon", body);
  const emoji = emojis.get(body.toLowerCase());
  return emoji ? iconValue("emoji", emoji) : null;
}

class ShortcodeWidget extends WidgetType {
  constructor(
    readonly body: string,
    readonly value: string,
  ) {
    super();
  }

  eq(other: ShortcodeWidget): boolean {
    return this.value === other.value && this.body === other.body;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-icon-shortcode";
    span.title = `:${this.body}:`;
    fillIconElement(span, this.value, { size: GLYPH_SIZE });
    return span;
  }
}

function buildDecorations(view: EditorView, emojis: ReadonlyMap<string, string>): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const ranges = getEffectiveSelectionRanges(view.state);
  for (const { from, to } of renderedRanges(view)) {
    const text = view.state.doc.sliceString(from, to);
    for (const match of text.matchAll(SHORTCODE)) {
      const start = from + match.index;
      const end = start + match[0].length;
      const value = shortcodeValue(match[1]!, emojis);
      if (!value || isInsideCode(view.state, start)) continue;
      if (ranges.some((r) => r.from <= end && r.to >= start)) continue;
      builder.add(
        start,
        end,
        Decoration.replace({ widget: new ShortcodeWidget(match[1]!, value) }),
      );
    }
  }
  return builder.finish();
}

function decorations(emojis: ReadonlyMap<string, string>) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildDecorations(view, emojis);
      }
      update(update: ViewUpdate) {
        if (update.docChanged || renderedRangesChanged(update) || update.selectionSet) {
          this.decorations = buildDecorations(update.view, emojis);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}

let iconIndex: Promise<IconIndexEntry[]> | null = null;
/** The Hugeicons names, searchable; loads the whole set (a few MB) the first time it is asked. */
function loadIconIndex(): Promise<IconIndexEntry[]> {
  iconIndex ??= loadIconSet().then((set) => buildIconIndex(Object.keys(set)));
  iconIndex.catch(() => (iconIndex = null));
  return iconIndex;
}

function completions(emojiList: ReturnType<typeof buildEmojiIndex>) {
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    const match = context.matchBefore(TRIGGER);
    if (!match) return null;
    // `a:bc` is not a shortcode: it starts where a word does not continue.
    const before = match.from > 0 ? context.state.doc.sliceString(match.from - 1, match.from) : "";
    if (/[\p{L}\p{N}]/u.test(before)) return null;
    if (!context.state.selection.main.empty || isInsideCode(context.state, match.from)) return null;
    const query = match.text.slice(1);
    const emoji: Completion[] = searchEmojiIndex(emojiList, query.replace(/[_-]/g, " "))
      .slice(0, MAX_PER_KIND)
      .map((e) => ({
        label: `:${emojiShortcode(e.name)}:`,
        detail: e.emoji,
        type: "emoji",
      }));
    let icons: Completion[] = [];
    try {
      icons = searchIconIndex(await loadIconIndex(), query)
        .slice(0, MAX_PER_KIND)
        .map((i) => ({ label: `:${i.name}:`, detail: "icon", type: "icon" }));
    } catch {
      // the icon set failed to load: emoji still complete
    }
    if (context.aborted) return null;
    const options = [...emoji, ...icons];
    if (options.length === 0) return null;
    return {
      from: match.from,
      options,
      // the labels are the replacement; CodeMirror's own label filter would drop name matches
      filter: false,
    };
  };
}

const theme = EditorView.baseTheme({
  ".cm-icon-shortcode": {
    verticalAlign: "-0.15em",
    alignItems: "center",
    justifyContent: "center",
    cursor: "default",
  },
});

/** The extension: renders the shortcodes and adds their completion. Loads the emoji names first
 *  (its own chunk), so the decorations never wait for data. */
export async function shortcodesExtension(): Promise<Extension> {
  const data = await loadEmoji();
  const emojis = new Map(data.emoji.map((e) => [emojiShortcode(e.name), e.emoji]));
  return [decorations(emojis), completionSources.of(completions(buildEmojiIndex(data))), theme];
}
