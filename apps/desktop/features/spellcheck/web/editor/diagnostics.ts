// Findings as CodeMirror diagnostics: severity, message and the actions of the tooltip ("Replace
// with ...", "Add to dictionary", "Ignore rule"). Pure apart from the handlers it is given, so it
// is tested without an editor.
import type { Action, Diagnostic } from "@codemirror/lint";
import type { Finding } from "../ipc";

/** Replacements offered per finding. */
export const MAX_REPLACEMENTS = 5;
/** The rules that report one misspelled word (Harper's and the Hunspell provider's): the word
 *  can be added to the dictionary. Any other rule can be ignored. */
export const WORD_RULES: ReadonlySet<string> = new Set(["SpellCheck", "hunspell.spelling"]);

export interface ActionHandlers {
  addWord: (word: string) => void;
  ignoreRule: (ruleId: string) => void;
}

export function actionsOf(f: Finding, handlers: ActionHandlers): Action[] {
  const actions: Action[] = f.replacements.slice(0, MAX_REPLACEMENTS).map((replacement) => ({
    name: replacement === "" ? "Remove" : `Replace with ${replacement}`,
    apply: (view, from, to) => {
      view.dispatch({ changes: { from, to, insert: replacement }, userEvent: "input.complete" });
    },
  }));
  if (WORD_RULES.has(f.ruleId)) {
    actions.push({
      name: "Add to dictionary",
      apply: (view, from, to) => handlers.addWord(view.state.sliceDoc(from, to)),
    });
  } else {
    actions.push({ name: "Ignore rule", apply: () => handlers.ignoreRule(f.ruleId) });
  }
  return actions;
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
    out.push({
      from,
      to,
      severity: f.kind === "style" ? "info" : "warning",
      message: f.message,
      source: f.kind,
      actions: actionsOf(f, handlers),
    });
  }
  return out;
}
