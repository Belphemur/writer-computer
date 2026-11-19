// The completion source of the tasks feature: it joins the editor's one autocompletion through
// `lib/editor-completion-sources.ts` (CodeMirror takes only one override).
import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { taskCompletionAt } from "./lib/completions";

export function taskCompletionSource(context: CompletionContext): CompletionResult | null {
  const line = context.state.doc.lineAt(context.pos);
  const hit = taskCompletionAt(line.text.slice(0, context.pos - line.from), new Date());
  if (!hit) return null;
  return {
    from: line.from + hit.from,
    options: hit.options.map((o) => ({ label: o.label, apply: o.apply, detail: o.detail })),
    filter: true,
  };
}
