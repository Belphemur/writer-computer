/**
 * Claude models for Settings > Agent and the composer's model chip. Claude's models cannot be
 * discovered from stream-json, so this is a static, versioned catalog in this one file. Update it
 * when Anthropic ships a model (bump `MODEL_CATALOG_VERSION`). Aliases (`opus`, `sonnet`, `haiku`)
 * track the latest model of a family and are accepted by `--model`; full names pin a version.
 * Beyond the catalog a model can come from the init event of the active session, from the user's
 * previously used `agent.model`, or from "Add custom model…".
 *
 * `agent.enabled-models` (a list setting) decides which models the composer offers. Composer
 * wiring: `useEnabledAgentModels` (`hooks/use-enabled-agent-models.ts`) or `enabledModelChoices`.
 */

/** Bumped with every catalog edit. Last reviewed: 2026-11-17. */
export const MODEL_CATALOG_VERSION = 1;

export type CatalogModel = {
  /** What is stored and passed as `--model`; `default` means "no flag, the CLI chooses". */
  id: string;
  label: string;
  description: string;
  /** Does the model take `--effort`? Unknown models are assumed to. */
  effort: boolean;
  alias: boolean;
  legacy?: boolean;
  /** Seen in a real session's init event (`claude-sonnet-5-5`); the others follow Anthropic's naming. */
  verified?: boolean;
};

export const DEFAULT_MODEL_ID = "default";

export const CLAUDE_MODEL_CATALOG: readonly CatalogModel[] = [
  {
    id: DEFAULT_MODEL_ID,
    label: "Default (recommended)",
    description: "The model Claude Code picks for your account. An org default may apply.",
    effort: true,
    alias: true,
  },
  {
    id: "opus",
    label: "Opus",
    description: "Alias for the latest Opus: most capable, slower.",
    effort: true,
    alias: true,
  },
  {
    id: "sonnet",
    label: "Sonnet",
    description: "Alias for the latest Sonnet: balanced speed and quality.",
    effort: true,
    alias: true,
  },
  {
    id: "haiku",
    label: "Haiku",
    description: "Alias for the latest Haiku: fastest, no effort levels.",
    effort: false,
    alias: true,
  },
  {
    id: "claude-opus-5-5",
    label: "Opus 5.5",
    description: "Pinned version.",
    effort: true,
    alias: false,
  },
  {
    id: "claude-sonnet-5-5",
    label: "Sonnet 5.5",
    description: "Pinned version.",
    effort: true,
    alias: false,
    verified: true,
  },
  {
    id: "claude-haiku-5-5",
    label: "Haiku 5.5",
    description: "Pinned version.",
    effort: false,
    alias: false,
  },
  {
    id: "claude-haiku-4-5",
    label: "Haiku 4.5",
    description: "Older version, kept for pinned setups.",
    effort: false,
    alias: false,
    legacy: true,
  },
];

/** What `agent.enabled-models` holds until the user changes it (also the schema default). */
export const DEFAULT_ENABLED_MODELS: readonly string[] = [
  DEFAULT_MODEL_ID,
  "opus",
  "sonnet",
  "haiku",
];

/** Same rule as the Rust `--model` validation (spec section 7). */
const MODEL_ID_RE = /^[A-Za-z0-9._:[\]/-]+$/;

export function isValidModelId(id: string): boolean {
  return MODEL_ID_RE.test(id) && !id.startsWith("-");
}

export function catalogModel(id: string): CatalogModel | undefined {
  return CLAUDE_MODEL_CATALOG.find((m) => m.id === id);
}

/** Normalised enabled list: strings only, valid ids, no duplicates, `default` always present. */
export function normalizeEnabled(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [...DEFAULT_ENABLED_MODELS];
  const out = [DEFAULT_MODEL_ID];
  for (const v of list) {
    if (typeof v === "string" && isValidModelId(v.trim()) && !out.includes(v.trim())) {
      out.push(v.trim());
    }
  }
  return out;
}

export type ModelRow = CatalogModel & {
  enabled: boolean;
  /** Not in the catalog: added by the user, the init event or a previous `agent.model`. */
  custom: boolean;
};

/** The rows of the models list: the catalog, then models the catalog does not know (enabled
 *  customs, the current `agent.model`, the active session's model). */
export function buildModelRows(
  enabledSetting: unknown,
  opts: { currentModel?: string | null; sessionModel?: string | null } = {},
): ModelRow[] {
  const enabled = normalizeEnabled(enabledSetting);
  const rows: ModelRow[] = CLAUDE_MODEL_CATALOG.map((m) => ({
    ...m,
    enabled: enabled.includes(m.id),
    custom: false,
  }));
  const extras = [...enabled, opts.currentModel ?? "", opts.sessionModel ?? ""].filter(
    (id) => id && isValidModelId(id) && !catalogModel(id),
  );
  for (const id of new Set(extras)) {
    rows.push({
      id,
      label: id,
      description: id === opts.sessionModel ? "Reported by the running session." : "Custom model.",
      effort: true,
      alias: false,
      enabled: enabled.includes(id),
      custom: true,
    });
  }
  return rows;
}

/** The setting value after toggling `id`. `default` cannot be switched off. */
export function toggleModel(enabledSetting: unknown, id: string, on: boolean): string[] {
  const enabled = normalizeEnabled(enabledSetting);
  if (id === DEFAULT_MODEL_ID) return enabled;
  const next = on ? [...enabled, id] : enabled.filter((x) => x !== id);
  return normalizeEnabled(next);
}

/** `agent.model` "" means the CLI default, same as the catalog's `default`. */
export const modelSettingToId = (value: unknown): string =>
  typeof value === "string" && value.trim() ? value.trim() : DEFAULT_MODEL_ID;

export const modelIdToSetting = (id: string): string => (id === DEFAULT_MODEL_ID ? "" : id);

/** Does the chosen model take `--effort`? (Settings greys the effort select out when not.) */
export function modelSupportsEffort(modelSetting: unknown): boolean {
  return catalogModel(modelSettingToId(modelSetting))?.effort ?? true;
}

export type ModelChoice = {
  id: string;
  label: string;
  /** What to put in `AgentSettings.model` / `--model`: null for the CLI default. */
  value: string | null;
  supportsEffort: boolean;
};

/** The models the composer's chip offers: the enabled ones, plus the model the chat currently
 *  uses even when it is not enabled (so the chip never shows a value it cannot list). */
export function enabledModelChoices(
  enabledSetting: unknown,
  opts: { currentModel?: string | null; sessionModel?: string | null } = {},
): ModelChoice[] {
  const current = opts.currentModel ? modelSettingToId(opts.currentModel) : null;
  return buildModelRows(enabledSetting, opts)
    .filter((r) => r.enabled || r.id === current)
    .map((r) => ({
      id: r.id,
      label: r.label,
      value: r.id === DEFAULT_MODEL_ID ? null : r.id,
      supportsEffort: r.effort,
    }));
}
