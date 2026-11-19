// Findings as CodeMirror diagnostics: severity and the tooltip card (a kind icon and the message,
// then one chip per replacement and, for a misspelled word, "Add to dictionary" and "Ignore" (this
// note only), else "Ignore rule"). The card is built in
// `renderMessage`, so the diagnostic carries no default `actions`. Pure apart from the handlers it
// is given, so it is tested without a full editor.
import { forEachDiagnostic, type Diagnostic } from "@codemirror/lint";
import type { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  Delete02Icon,
  MagicWand01Icon,
  PlusSignIcon,
  SpellCheckIcon,
  TextFontIcon,
  ViewOffIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { svgFromIcon } from "@/lib/icon-picker/icon-dom";
import { editorNotePath } from "@/lib/editor-views";
import type { Finding } from "../ipc";
import { encodeSource, keyFromSource, matchCase, type IssueGroup } from "../lib/issue-groups";

/** Replacements offered per finding. */
export const MAX_REPLACEMENTS = 5;
/** The rules that report one misspelled word (Harper's and the Hunspell provider's): the word
 *  can be added to the dictionary. Any other rule can be ignored. */
export const WORD_RULES: ReadonlySet<string> = new Set(["SpellCheck", "hunspell.spelling"]);

export interface ActionHandlers {
  addWord: (word: string) => void;
  /** Stop flagging `word` in the note at `filePath` (absolute) only. */
  ignoreWord: (word: string, filePath: string) => void;
  ignoreRule: (ruleId: string) => void;
}

const KIND_ICONS: Record<Finding["kind"], IconSvgElement> = {
  spelling: SpellCheckIcon,
  grammar: TextFontIcon,
  style: MagicWand01Icon,
};
const KIND_TITLES: Record<Finding["kind"], string> = {
  spelling: "Spelling",
  grammar: "Grammar",
  style: "Style",
};
const ICON_SIZE = 14;

function chip(label: string, icon: IconSvgElement | null, secondary: boolean): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = secondary ? "cm-spell-chip cm-spell-chip-secondary" : "cm-spell-chip";
  if (icon) button.append(svgFromIcon(icon, ICON_SIZE));
  const text = document.createElement("span");
  text.textContent = label;
  button.append(text);
  return button;
}

export interface LiveDiagnostic {
  diagnostic: Diagnostic;
  from: number;
  to: number;
}

/** The diagnostics the editor holds right now, with their ranges mapped through every edit since
 *  the check. The one range lookup: the tooltip's chips and the popover's fix-all both use it. */
export function liveDiagnostics(state: EditorState): LiveDiagnostic[] {
  const out: LiveDiagnostic[] = [];
  forEachDiagnostic(state, (diagnostic, from, to) => out.push({ diagnostic, from, to }));
  return out;
}

/** The live diagnostics minus the spelling hits on `word` (any case), or `null` when none is
 *  there: "Add to dictionary" drops them at once, before the re-check confirms. */
export function withoutWord(state: EditorState, word: string): Diagnostic[] | null {
  const folded = word.toLowerCase();
  const live = liveDiagnostics(state);
  const kept = live.filter((l) => {
    const ruleId = (l.diagnostic.source ?? "").split("\u0000")[1] ?? "";
    return !(WORD_RULES.has(ruleId) && state.sliceDoc(l.from, l.to).toLowerCase() === folded);
  });
  if (kept.length === live.length) return null;
  return kept.map((l) => ({ ...l.diagnostic, from: l.from, to: l.to }));
}

/** The live occurrences of an issue group, in document order. */
export function liveOccurrences(state: EditorState, group: IssueGroup): LiveDiagnostic[] {
  return liveDiagnostics(state)
    .filter((l) => keyFromSource(l.diagnostic.source, state.sliceDoc(l.from, l.to)) === group.key)
    .sort((a, b) => a.from - b.from);
}

/** Replaces every live occurrence of a group in one transaction. */
export function fixAll(view: EditorView, group: IssueGroup, replacement: string): void {
  const changes = liveOccurrences(view.state, group).map((l) => ({
    from: l.from,
    to: l.to,
    insert: matchCase(view.state.sliceDoc(l.from, l.to), replacement),
  }));
  if (changes.length) view.dispatch({ changes, userEvent: "input.complete" });
}

/** Selects the next live occurrence after the cursor (wrapping) and scrolls it into view through
 *  CodeMirror, never the DOM. Returns whether there was one. */
export function jumpToNext(view: EditorView, group: IssueGroup): boolean {
  const all = liveOccurrences(view.state, group);
  if (!all.length) return false;
  const head = view.state.selection.main.head;
  const target = all.find((l) => l.from >= head) ?? all[0]!;
  view.dispatch({
    selection: { anchor: target.from, head: target.to },
    effects: EditorView.scrollIntoView(target.from, { y: "center" }),
  });
  view.focus();
  return true;
}

/** The card: kind icon + message, then the action chips. A click looks the diagnostic up in the
 *  editor state at that moment, so edits since the check have mapped its range. */
function renderCard(
  f: Finding,
  handlers: ActionHandlers,
  diagnostic: Diagnostic,
  view: EditorView,
) {
  const run = (act: (from: number, to: number) => void) => {
    const live = liveDiagnostics(view.state).find((l) => l.diagnostic === diagnostic);
    if (live) act(live.from, live.to);
  };
  const card = document.createElement("div");
  card.className = "cm-spell-card";
  card.dataset.kind = f.kind;

  const head = document.createElement("div");
  head.className = "cm-spell-head";
  const icon = document.createElement("span");
  icon.className = `cm-spell-kind cm-spell-kind-${diagnostic.severity}`;
  icon.append(svgFromIcon(KIND_ICONS[f.kind], ICON_SIZE));
  const title = document.createElement("span");
  title.className = "cm-spell-title";
  title.textContent = KIND_TITLES[f.kind];
  head.append(icon, title);
  const message = document.createElement("div");
  message.className = "cm-spell-message";
  message.textContent = f.message;

  const row = document.createElement("div");
  row.className = "cm-spell-actions";
  for (const replacement of f.replacements.slice(0, MAX_REPLACEMENTS)) {
    const button = chip(
      replacement === "" ? "Remove" : replacement,
      replacement === "" ? Delete02Icon : null,
      false,
    );
    button.addEventListener("click", (e) => {
      e.preventDefault();
      run((from, to) =>
        view.dispatch({ changes: { from, to, insert: replacement }, userEvent: "input.complete" }),
      );
    });
    row.append(button);
  }
  if (WORD_RULES.has(f.ruleId)) {
    const button = chip("Add to dictionary", PlusSignIcon, true);
    button.addEventListener("click", (e) => {
      e.preventDefault();
      run((from, to) => handlers.addWord(view.state.sliceDoc(from, to)));
    });
    row.append(button);
    const ignore = chip("Ignore", ViewOffIcon, true);
    ignore.addEventListener("click", (e) => {
      e.preventDefault();
      const filePath = view.state.facet(editorNotePath)();
      run((from, to) => filePath && handlers.ignoreWord(view.state.sliceDoc(from, to), filePath));
    });
    row.append(ignore);
  } else {
    const button = chip("Ignore rule", ViewOffIcon, true);
    button.addEventListener("click", (e) => {
      e.preventDefault();
      handlers.ignoreRule(f.ruleId);
    });
    row.append(button);
  }
  card.append(head, message, row);
  return card;
}

/** Spelling and grammar are warnings, style is information (ADR point 8). Offsets past the end
 *  of the document (the text changed after the answer) are clamped so CodeMirror never throws. */
export function toDiagnostics(
  findings: readonly Finding[],
  docLength: number,
  handlers: ActionHandlers,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const f of findings) {
    const from = Math.min(f.start, docLength);
    const to = Math.min(f.end, docLength);
    if (from >= to) continue;
    const diagnostic: Diagnostic = {
      from,
      to,
      severity: f.kind === "style" ? "info" : "warning",
      message: f.message,
      source: encodeSource(f.kind, f.ruleId),
      renderMessage: (view) => renderCard(f, handlers, diagnostic, view),
    };
    out.push(diagnostic);
  }
  return out;
}
