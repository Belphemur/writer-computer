/**
 * The pure side of the models table: tabs, search and the number formats. The enabled rule is the
 * shared `isModelEnabled`: a model is enabled unless its slug is in `agent.opencode.disabled-models`,
 * the server's own switch (`available`) first.
 */
import { isModelEnabled, type BackendModel } from "@/lib/features/agent-backends";
import type { OpencodeModel } from "../ipc";

export type ModelTab = "all" | "enabled" | "free";
export const MODEL_TABS: readonly { id: ModelTab; label: string }[] = [
  { id: "all", label: "All" },
  { id: "enabled", label: "Enabled" },
  { id: "free", label: "Free" },
];

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

/** The `disabled-models` list after switching `id` on or off (no duplicates, order kept). */
export function withEnabled(disabled: readonly string[], id: string, on: boolean): string[] {
  const rest = disabled.filter((x) => x !== id);
  return on ? rest : [...rest, id];
}

export function filterModels(
  models: readonly BackendModel[],
  opts: { tab: ModelTab; query: string; disabled: readonly string[] },
): BackendModel[] {
  const q = opts.query.trim().toLowerCase();
  return models.filter((m) => {
    if (opts.tab === "enabled" && !isModelEnabled(m, opts.disabled)) return false;
    if (opts.tab === "free" && !m.free) return false;
    return !q || `${m.provider ?? ""} ${m.label}`.toLowerCase().includes(q);
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
