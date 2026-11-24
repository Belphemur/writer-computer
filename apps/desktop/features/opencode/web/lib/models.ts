/**
 * The pure side of the models table: provider tabs, the Enabled and Free chips, search and the number
 * formats. The enabled rule is the shared `isModelEnabled`: a model is enabled unless its slug is in
 * `agent.opencode.disabled-models` (`switchedAfter` writes it), the server's own switch
 * (`available`) first.
 */
import {
  groupByProvider,
  isModelEnabled,
  matchesQuery,
  type BackendModel,
} from "@/lib/features/agent-backends";
import type { OpencodeModel } from "../ipc";

/** The providers present in the list, by the name the server reports, in alphabetical order
 *  (the tab row of the table; the first tab, All, is not one of them). */
export const providerTabs = (models: readonly BackendModel[]): string[] =>
  groupByProvider(models).map((g) => g.provider);

/** The selected provider when the list still has it, else `null` (All): a refreshed list that lost
 *  the provider falls back to All. */
export const resolveProvider = (
  selected: string | null,
  providers: readonly string[],
): string | null => (selected !== null && providers.includes(selected) ? selected : null);

/** The server's row as the shared backend model (the chip, the start and this table read one). */
export const toBackendModel = (m: OpencodeModel): BackendModel => ({
  id: m.id,
  label: m.name,
  provider: m.provider,
  variants: m.variants,
  available: m.available,
  free: m.free,
  context: m.context,
  inputCost: m.inputCost,
  outputCost: m.outputCost,
  image: m.image,
  pdf: m.pdf,
  tools: m.tools,
  reasoning: m.reasoning,
});

/** The rows of the table: the provider tab (`null` is All), the Enabled and Free chips and the
 *  search all narrow together. */
export function filterModels(
  models: readonly BackendModel[],
  opts: {
    provider: string | null;
    enabled: boolean;
    free: boolean;
    query: string;
    disabled: readonly string[];
  },
): BackendModel[] {
  return models.filter((m) => {
    if (opts.provider !== null && m.provider !== opts.provider) return false;
    if (opts.enabled && !isModelEnabled(m, opts.disabled)) return false;
    if (opts.free && !m.free) return false;
    return matchesQuery(opts.query, m.provider, m.label);
  });
}

/** `$0.30` per million tokens, `Free`, or `-` when the server gave no price. */
export function formatCost(cost: number | null, free: boolean): string {
  if (free) return "Free";
  if (cost === null) return "-";
  return `$${cost.toFixed(2)}`;
}

/** `200K` or `1M` tokens; `-` when unknown. */
export function formatContext(tokens: number | null): string {
  if (tokens === null) return "-";
  if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
  return String(tokens);
}
