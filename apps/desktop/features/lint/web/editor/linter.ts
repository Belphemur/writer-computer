// The CodeMirror side: a `linter` source that sends the note to the Rust engine, debounced, and
// draws what comes back as warnings with a card (the rule, the message, "Fix" and "Turn off").
// This module is the lazy `lint.linter` editor extension (the feature's entry stays import-light).
//
// - Stale answers: `@codemirror/lint` drops an answer when the document changed while it was away.
// - Re-checks without an edit: the rules chosen in Settings changing is a `refresh` effect, which
//   `needsRefresh` turns into a run of every source (spelling and lint together, as the library
//   batches them), not a lone `setDiagnostics` that would wipe the other source's marks.
// - "Fix" asks Rust again at the click, so its edits are placed in the document as it is now, not
//   as it was when the warning was drawn; nothing is applied when the answer no longer has it.
import { forEachDiagnostic, linter, type Diagnostic } from "@codemirror/lint";
import { StateEffect } from "@codemirror/state";
import { ViewPlugin, type EditorView } from "@codemirror/view";
import { editorNotePath } from "@/lib/editor-views";
import { logger } from "@/lib/logger";
import { useSettingsStore } from "@/stores/settings-store";
import { check, type Finding } from "../ipc";
import { fixFinding, isMarkdownPath, idleFix, LINT_DEBOUNCE_MS, MAX_LINT_CHARS } from "../lib/fix";
import { enabledRules, lintSignature, RULES, setRule } from "../lib/settings";
import { lintTheme } from "./lint-theme";

/** Sent when the rules in force changed: the library lints again, with every source. */
export const refresh = StateEffect.define<null>();

const ruleName = (id: string) => RULES.find((r) => r.id === id)?.name ?? id;

/** The warning card: the rule's name, rumdl's message, then the chips. Built in `renderMessage`,
 *  so the diagnostic carries no default `actions` buttons. */
function renderCard(f: Finding, view: EditorView, start: () => number) {
  const card = document.createElement("div");
  card.className = "cm-lint-card";
  const title = document.createElement("div");
  title.className = "cm-lint-title";
  title.textContent = `${f.rule} ${ruleName(f.rule)}`;
  const message = document.createElement("div");
  message.className = "cm-lint-message";
  message.textContent = f.message;
  const row = document.createElement("div");
  row.className = "cm-lint-actions";
  const chip = (label: string, quiet: boolean, onClick: () => void) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = quiet ? "cm-lint-chip cm-lint-chip-quiet" : "cm-lint-chip";
    b.textContent = label;
    b.addEventListener("click", (e) => {
      e.preventDefault();
      onClick();
    });
    row.append(b);
  };
  if (f.fix.length > 0) chip("Fix", false, () => void fixFinding(view, f.rule, start()));
  chip("Turn off rule", true, () => void setRule(f.rule, false));
  card.append(title, message, row);
  return card;
}

/** The start of `diagnostic` as the editor holds it now (edits since the check mapped it). */
function liveFrom(view: EditorView, diagnostic: Diagnostic): number | null {
  let start: number | null = null;
  forEachDiagnostic(view.state, (d, from) => {
    if (d === diagnostic) start = from;
  });
  return start;
}

/** Findings as diagnostics. Offsets past the end of the document (it changed after the answer)
 *  are clamped so CodeMirror never throws; a finding with no width (a missing final newline) is
 *  drawn on the character before or after it. */
export function toDiagnostics(findings: readonly Finding[], docLength: number): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const f of findings) {
    let from = Math.min(f.start, docLength);
    let to = Math.min(f.end, docLength);
    if (from === to) {
      if (to < docLength) to += 1;
      else if (from > 0) from -= 1;
    }
    if (from >= to) continue;
    const shift = f.start - from; // how far the drawn range starts before the finding
    const diagnostic: Diagnostic = {
      from,
      to,
      severity: f.severity,
      message: f.message,
      source: f.rule,
      renderMessage: (view) =>
        renderCard(f, view, () => (liveFrom(view, diagnostic) ?? from) + shift),
    };
    out.push(diagnostic);
  }
  return out;
}

export async function runCheck(view: EditorView): Promise<Diagnostic[]> {
  if (enabledRules().size === 0) return [];
  const doc = view.state.doc;
  if (doc.length > MAX_LINT_CHARS) return [];
  const abs = view.state.facet(editorNotePath)();
  if (!abs || !isMarkdownPath(abs)) return [];
  try {
    return toDiagnostics(await check(doc.toString()), doc.length);
  } catch (e) {
    logger.warn("lint", `the check failed: ${String(e)}`);
    return [];
  }
}

/** Tells the library to lint again when the rules in force changed without an edit. */
const followSettings = ViewPlugin.define((view) => {
  let signature = lintSignature();
  const stop = useSettingsStore.subscribe((s) => {
    const next = lintSignature(s.settings);
    if (next === signature) return;
    signature = next;
    view.dispatch({ effects: refresh.of(null) });
  });
  return { destroy: stop };
});

export function lintExtension() {
  return [
    linter((view) => runCheck(view), {
      delay: LINT_DEBOUNCE_MS,
      needsRefresh: (update) =>
        update.transactions.some((tr) => tr.effects.some((e) => e.is(refresh))),
    }),
    lintTheme,
    followSettings,
    idleFix,
  ];
}

export default lintExtension;
