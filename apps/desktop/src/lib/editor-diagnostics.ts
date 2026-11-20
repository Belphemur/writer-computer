// Two features can draw diagnostics in one editor (spelling and lint). `@codemirror/lint`'s
// `setDiagnostics` replaces every source's marks, so a feature that re-checks outside the
// library's own run (nothing was typed) must replace only its own: this is the one way to do it.
// The marks it does not own are kept as the editor holds them now (mapped through every edit).
import { forEachDiagnostic, setDiagnostics, type Diagnostic } from "@codemirror/lint";
import type { EditorView } from "@codemirror/view";

/** Replaces the diagnostics `owns` says are yours with `next`; every other one stays. */
export function replaceOwnDiagnostics(
  view: EditorView,
  owns: (diagnostic: Diagnostic) => boolean,
  next: readonly Diagnostic[],
): void {
  const kept: Diagnostic[] = [];
  forEachDiagnostic(view.state, (diagnostic, from, to) => {
    if (!owns(diagnostic)) kept.push({ ...diagnostic, from, to });
  });
  view.dispatch(setDiagnostics(view.state, [...kept, ...next]));
}
