// Autocomplete sources that editor extensions add (a feature's `:shortcode:` completion). The
// editor has one `autocompletion({ override })` (the `[[` note names, `wiki-link-extension.ts`):
// CodeMirror refuses two overrides, so the other sources join through this facet, which that one
// override reads. A feature provides `completionSources.of(source)` from its editor extension,
// so the source goes away with the extension when the feature is switched off.
import type {
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from "@codemirror/autocomplete";
import { Facet } from "@codemirror/state";

export const completionSources = Facet.define<CompletionSource, readonly CompletionSource[]>({
  combine: (sources) => sources,
});

/** The first contributed source that has something for the cursor (their triggers differ). */
export async function contributedCompletions(
  context: CompletionContext,
): Promise<CompletionResult | null> {
  for (const source of context.state.facet(completionSources)) {
    const result = await source(context);
    if (result) return result;
  }
  return null;
}
