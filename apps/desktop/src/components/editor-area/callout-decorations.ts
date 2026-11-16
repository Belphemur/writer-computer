// Obsidian-style callouts (`> [!info] Title`) in the live editor. See SPECs/callouts-spec.md.
//
// The body stays the real blockquote lines: line decorations give them the card look, so typing,
// selection, undo and find behave as for any quote. Only the `> [!type]+ ` prefix is swapped for
// an icon widget while the selection is away, and a chevron widget at the end of the header
// toggles folding. Folding replaces the body lines (state, never written to the note).
import {
  type EditorState,
  type Extension,
  type Range,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import "@/lib/callouts/callouts.css";
import { applyCustomCalloutIcons, readCustomCalloutIcons } from "@/lib/callouts/dom";
import { getCalloutFolds, setCalloutFolded } from "@/lib/callouts/fold-state";
import { createCalloutChevron, createCalloutIcon } from "@/lib/callouts/icons";
import { type BuiltinCallout, defaultCalloutTitle } from "@/lib/callouts/syntax";
import { type CalloutInfo, scanCallouts } from "@/lib/callouts/tree";
import { unfurlFreezeFacet } from "@/lib/prosemark-core/main";
import { treeChanged } from "@/lib/prosemark-core/utils";
import { dragFrozenSelectionField } from "./drag-selection-gate";

/** Sets one callout's folded state (by index) in the field. */
export const setFoldedEffect = StateEffect.define<{ index: number; folded: boolean }>();

interface CalloutState {
  path: string;
  infos: readonly CalloutInfo[];
  /** Reader's fold choices; a callout without one uses its `+` / `-` marker. */
  overrides: ReadonlyMap<number, boolean>;
  decorations: DecorationSet;
  /** The replaced (folded away) body ranges, for `atomicRanges`. */
  atomic: DecorationSet;
}

// ------------------------------------------------------------------ widgets

class CalloutIconWidget extends WidgetType {
  constructor(
    readonly kind: BuiltinCallout,
    /** Shown when the header has no title of its own. */
    readonly fallbackTitle: string | null,
  ) {
    super();
  }

  eq(other: CalloutIconWidget): boolean {
    return other.kind === this.kind && other.fallbackTitle === this.fallbackTitle;
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "cm-callout-prefix";
    const icon = document.createElement("span");
    icon.className = "callout-icon";
    icon.append(createCalloutIcon(document, this.kind));
    wrap.append(icon);
    if (this.fallbackTitle !== null) {
      const title = document.createElement("span");
      title.className = "callout-title-inner";
      title.textContent = this.fallbackTitle;
      wrap.append(title);
    }
    return wrap;
  }

  // A click on the icon or default title places the caret at the callout, which reveals it.
  ignoreEvent(): boolean {
    return false;
  }
}

type ToggleFold = (view: EditorView, index: number) => void;

class CalloutFoldWidget extends WidgetType {
  constructor(
    readonly index: number,
    readonly folded: boolean,
    // One closure per extension instance, so it is left out of `eq`.
    readonly toggle: ToggleFold,
  ) {
    super();
  }

  eq(other: CalloutFoldWidget): boolean {
    return other.index === this.index && other.folded === this.folded;
  }

  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement("span");
    el.className = this.folded ? "callout-fold is-collapsed" : "callout-fold";
    el.setAttribute("role", "button");
    el.setAttribute("aria-label", this.folded ? "Expand callout" : "Collapse callout");
    el.setAttribute("aria-expanded", String(!this.folded));
    el.dataset.calloutIndex = String(this.index);
    el.append(createCalloutChevron(document));
    // Keep the caret and focus where they are (docs/editor.md, "Buttons inside widgets"); the
    // toggle runs on click.
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    el.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.toggle(view, this.index);
    });
    return el;
  }

  // The listeners above own pointer events on the chevron.
  ignoreEvent(): boolean {
    return true;
  }
}

// ------------------------------------------------------------------ decorations

const lineDecoCache = new Map<string, Decoration>();
function lineDeco(
  info: CalloutInfo,
  flags: { header: boolean; first: boolean; last: boolean; revealed: boolean; folded: boolean },
): Decoration {
  const { header } = info;
  const classes = ["cm-callout-line", "callout"];
  if (flags.header) classes.push("callout-title", "cm-callout-header");
  if (flags.first) classes.push("cm-callout-first");
  if (flags.last) classes.push("cm-callout-last");
  if (flags.revealed) classes.push("cm-callout-revealed");
  if (header.fold !== "") classes.push("is-collapsible");
  if (flags.folded) classes.push("is-collapsed");
  const key = `${classes.join(" ")}|${header.type}|${header.fold}|${header.metadata}`;
  let deco = lineDecoCache.get(key);
  if (!deco) {
    const attributes: Record<string, string> = {
      class: classes.join(" "),
      "data-callout": header.type,
      "data-callout-fold": header.fold,
    };
    if (header.metadata) attributes["data-callout-metadata"] = header.metadata;
    deco = Decoration.line({ attributes });
    // The cache only holds distinct callout types seen this session; keep it bounded anyway.
    if (lineDecoCache.size > 500) lineDecoCache.clear();
    lineDecoCache.set(key, deco);
  }
  return deco;
}

const titleMark = Decoration.mark({ class: "callout-title-inner" });
const foldedBody = Decoration.replace({});

function isFolded(info: CalloutInfo, overrides: ReadonlyMap<number, boolean>): boolean {
  return info.header.fold !== "" && (overrides.get(info.index) ?? info.header.fold === "-");
}

export function buildCalloutDecorations(
  state: EditorState,
  infos: readonly CalloutInfo[],
  overrides: ReadonlyMap<number, boolean>,
  selection: readonly { from: number; to: number }[],
  toggle: ToggleFold = () => {},
): { decorations: DecorationSet; atomic: DecorationSet } {
  const { doc } = state;
  const decos: Range<Decoration>[] = [];
  const atomic: Range<Decoration>[] = [];
  for (const info of infos) {
    if (info.inList) continue;
    const { header } = info;
    const touches = (from: number, to: number) =>
      selection.some((r) => r.from <= to && from <= r.to);
    // Whole callout, like the quote's own hide zone: the source shows while the caret is in it.
    const revealed = touches(info.headerLineFrom, info.lastLineTo);
    const hasBody = info.lastLineTo > info.headerLineTo;
    const folded = isFolded(info, overrides);
    // A caret on the header line keeps a folded callout folded; one in the body opens it.
    const bodyHidden = folded && hasBody && !touches(info.headerLineTo + 1, info.lastLineTo);

    const firstLine = doc.lineAt(info.headerLineFrom).number;
    const lastLine = bodyHidden ? firstLine : doc.lineAt(info.lastLineTo).number;
    for (let n = firstLine; n <= lastLine; n++) {
      decos.push(
        lineDeco(info, {
          header: n === firstLine,
          first: n === firstLine,
          last: n === lastLine,
          revealed,
          folded,
        }).range(doc.line(n).from),
      );
    }

    const titleEmpty = header.title === "";
    if (!revealed) {
      decos.push(
        Decoration.replace({
          widget: new CalloutIconWidget(
            header.kind,
            titleEmpty ? defaultCalloutTitle(header.type) : null,
          ),
        }).range(info.nodeFrom, titleEmpty ? info.headerLineTo : info.titleFrom),
      );
    }
    if (!titleEmpty) decos.push(titleMark.range(info.titleFrom, info.titleTo));
    if (header.fold !== "") {
      decos.push(
        Decoration.widget({
          widget: new CalloutFoldWidget(info.index, folded, toggle),
          side: 1,
        }).range(info.headerLineTo),
      );
    }
    if (bodyHidden) {
      decos.push(foldedBody.range(info.headerLineTo, info.lastLineTo));
      atomic.push(foldedBody.range(info.headerLineTo, info.lastLineTo));
    }
  }
  return { decorations: Decoration.set(decos, true), atomic: Decoration.set(atomic, true) };
}

// ------------------------------------------------------------------ state

function effectiveSelection(state: EditorState): readonly { from: number; to: number }[] {
  return state.field(dragFrozenSelectionField, false) ?? state.selection.ranges;
}

function derive(
  state: EditorState,
  path: string,
  infos: readonly CalloutInfo[],
  overrides: ReadonlyMap<number, boolean>,
  toggle: ToggleFold,
): CalloutState {
  return {
    path,
    infos,
    overrides,
    ...buildCalloutDecorations(state, infos, overrides, effectiveSelection(state), toggle),
  };
}

export function calloutField(getFilePath: () => string): StateField<CalloutState> {
  const toggle: ToggleFold = (view, index) => toggleFold(view, field, getFilePath, index);
  const field: StateField<CalloutState> = StateField.define<CalloutState>({
    create(state) {
      const path = getFilePath();
      return derive(state, path, scanCallouts(state), new Map(getCalloutFolds(path)), toggle);
    },
    update(value, tr) {
      const path = getFilePath();
      let { infos, overrides } = value;
      let dirty = false;
      if (path !== value.path) {
        overrides = new Map(getCalloutFolds(path));
        dirty = true;
      }
      for (const effect of tr.effects) {
        if (!effect.is(setFoldedEffect)) continue;
        overrides = new Map(overrides).set(effect.value.index, effect.value.folded);
        dirty = true;
      }
      if (dirty || tr.docChanged || treeChanged(tr)) {
        // While a drag is in flight the selection (and so the reveal) is frozen; doc changes
        // still rescan so positions stay valid.
        infos = scanCallouts(tr.state);
        dirty = true;
      }
      const frozen = tr.state.facet(unfurlFreezeFacet);
      if (!dirty && !(tr.selection && !frozen)) return value;
      return derive(tr.state, path, infos, overrides, toggle);
    },
    provide: (f) => [
      EditorView.decorations.from(f, (v) => v.decorations),
      EditorView.atomicRanges.of((view) => view.state.field(f).atomic),
    ],
  });
  return field;
}

// ------------------------------------------------------------------ interaction

// Fold or unfold the callout the chevron belongs to. The reader's choice goes to the in-memory
// store (session only) and into the field. Folding with the caret in the body moves it to the
// header, since the body is about to disappear.
function toggleFold(
  view: EditorView,
  field: StateField<CalloutState>,
  getFilePath: () => string,
  index: number,
): void {
  const value = view.state.field(field);
  const info = value.infos.find((c) => c.index === index);
  if (!info) return;
  const folded = !isFolded(info, value.overrides);
  setCalloutFolded(getFilePath(), index, folded);
  const inBody = view.state.selection.ranges.some(
    (r) => r.from <= info.lastLineTo && info.headerLineTo + 1 <= r.to,
  );
  view.dispatch({
    effects: setFoldedEffect.of({ index, folded }),
    ...(folded && inBody ? { selection: { anchor: info.headerLineTo } } : {}),
  });
}

// A user snippet's `--callout-icon` can only be read from computed style, so measure after each
// update that can change the callouts on screen and swap the icons that asked for another one.
const customIconPlugin = ViewPlugin.fromClass(
  class {
    constructor(readonly view: EditorView) {
      this.schedule();
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.selectionSet || treeChanged(u)) this.schedule();
    }
    schedule() {
      this.view.requestMeasure({
        key: this,
        read: (v) => readCustomCalloutIcons(v.contentDOM),
        write: (icons) => applyCustomCalloutIcons(icons),
      });
    }
  },
);

export function calloutDecorations(getFilePath: () => string): Extension {
  return [calloutField(getFilePath), customIconPlugin];
}
