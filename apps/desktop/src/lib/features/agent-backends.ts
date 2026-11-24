// Agent backends contributed by features (`agent.backends`, SPECs/opencode-backend-spec.md section
// 5 and SPECs/builtin-plugins-spec.md 6.5). The agent pane, its Settings tab and its model chip read
// this registry, so they name no backend (docs/consolidation.md: registry over per-case branches).
// Entries exist while the contributing feature is on; Claude is the pane's own built-in entry.
import type { ComponentType } from "react";
import { OwnedRegistry } from "@/lib/owned-registry";
import { isSwitchOn } from "@/lib/switches";

/** What a backend's program detection says (the agent's `AgentBinaryInfo` has these fields too). */
export interface DetectedProgram {
  found: boolean;
  path: string | null;
  version: string | null;
  /** `null` or absent: unknown. */
  authenticated?: boolean | null;
  /** The backend's own verdict on the version (OpenCode's: it knows its pinned range); `null` or
   *  absent: not said, the descriptor's `minVersion` decides. */
  supported?: boolean | null;
  /** The oldest version the backend supports, when it says (shown with an unsupported version). */
  minVersion?: string | null;
}

/** The effort levels Writer can select (the wire's `Effort`): a backend's other levels (`none`,
 *  `minimal`) are not offered. */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export const EFFORT_LABEL: Record<(typeof EFFORT_LEVELS)[number], string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

/** The variants of a model that are in `EFFORT_LEVELS`, in the backend's order. */
export const selectableEfforts = (variants: readonly string[]): string[] =>
  variants.filter((v) => (EFFORT_LEVELS as readonly string[]).includes(v));

/** One model of a backend's live list, as the model chip and Settings need it. */
export interface BackendModel {
  /** What is stored as the chat's model and passed to the backend. */
  id: string;
  label: string;
  provider?: string;
  /** The effort levels the model takes, in the backend's order; empty: none. */
  variants: readonly string[];
  /** False: the backend turned it off or retired it (never offered). */
  available: boolean;
  free?: boolean;
  /** What the models table shows, when the backend says (tokens; USD per 1M tokens). */
  context?: number | null;
  inputCost?: number | null;
  outputCost?: number | null;
  image?: boolean;
  pdf?: boolean;
  tools?: boolean;
  reasoning?: boolean;
}

/** Items grouped by their provider's name, alphabetical; items with no provider are left out. The
 *  one grouping of the models table's tabs and the model chip's menu headers. */
export function groupByProvider<T extends { provider?: string }>(
  items: readonly T[],
): { provider: string; items: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const it of items) {
    if (!it.provider) continue;
    const g = groups.get(it.provider);
    if (g) g.push(it);
    else groups.set(it.provider, [it]);
  }
  return [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([provider, list]) => ({ provider, items: list }));
}

/** Does a row match what was typed in a search? The row's words (a model's provider and name, an
 *  MCP server's name and raw names), case-insensitive, blank matches all. The one rule of the
 *  models table, the model menu and the MCP servers menu. */
export const matchesQuery = (query: string, ...words: (string | undefined)[]): boolean => {
  const q = query.trim().toLowerCase();
  return (
    !q ||
    words
      .map((w) => w ?? "")
      .join(" ")
      .toLowerCase()
      .includes(q)
  );
};

/** A list setting as strings (a value that is not a list is empty). One reader for every place a
 *  backend's list settings are read. */
export const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];

/** The one enabled rule: the backend has the model on and the user has not switched it off (the
 *  models are on unless listed, `src/lib/switches.ts`). */
export const isModelEnabled = (
  m: { id: string; available: boolean },
  disabled: readonly string[],
): boolean => m.available && isSwitchOn(disabled, m.id, true);

/** The one model resolver (Settings, the chip and the start): an explicit `model` is itself (null
 *  when the list does not know it); blank is the first model of the list that is enabled. */
export function resolveModel<M extends { id: string; available: boolean }>(
  models: readonly M[],
  disabled: readonly string[],
  model: string | null,
): M | null {
  return (
    (model
      ? models.find((m) => m.id === model)
      : models.find((m) => isModelEnabled(m, disabled))) ?? null
  );
}

/** The settings keys neutral code reads for a chat of this backend. */
export interface BackendSettingKeys {
  binaryPath: string;
  model: string;
  effort: string;
  /** A list of model ids switched off (live-list backends). */
  disabledModels?: string;
  /** Tier name (`shared/agent-roles.json`) to the setting holding its model. */
  tiers: Record<string, string>;
}

export interface AgentBackendContribution {
  /** `<feature id>.<name>`. */
  id: string;
  /** The id Rust knows the backend by (`agent_start`'s `backend`, the chat note's `writer-chat-backend`). */
  backendId: string;
  label: string;
  /** The letter of its tile (Writer's own mark, never a vendor logo). */
  glyph: string;
  /** The program's name, for status text. */
  program: string;
  installUrl: string;
  keys: BackendSettingKeys;
  /** What the "sign in required" card says and the command it copies. */
  signIn: { hint: string; command: string };
  /** One short sentence added to the shell approval card, for what a shell command can reach
   *  through this backend (the card's own line is neutral and shared by every backend). */
  shellNote?: string;
  detect(binaryOverride: string | null): Promise<DetectedProgram>;
  /** The live list for the model chip and the models table; rejects when the backend cannot say. */
  models(): Promise<BackendModel[]>;
  /** The body of the Settings > Agent tab (lazy; rendered inside the feature's error boundary). */
  settingsPanel: () => Promise<ComponentType>;
  /** The backend's tool table (`features/<id>/tools.json`, the shape of `shared/agent-tools/*.json`). */
  toolTable: unknown;
}

export type OwnedAgentBackend = AgentBackendContribution & { owner: string };

export const agentBackendContributions = new OwnedRegistry<OwnedAgentBackend>();

// ---------------------------------------------------------------------------------------------
// The one loader of a backend's live model list (the chip, the start and Settings share it)

const cache = new Map<string, Promise<BackendModel[]>>();
const invalidated = new Set<() => void>();

/** The backend's list, fetched once per session. A failure and an empty list (a server still
 *  settling) are never kept: the next call asks again. */
export function loadBackendModels(backend: {
  backendId?: string;
  id?: string;
  models?: () => Promise<BackendModel[]>;
}): Promise<BackendModel[]> {
  const key = backend.backendId ?? backend.id ?? "";
  if (!backend.models) return Promise.resolve([]);
  let p = cache.get(key);
  if (!p) {
    p = backend.models();
    cache.set(key, p);
    p.then(
      (list) => list.length === 0 && cache.get(key) === p && cache.delete(key),
      () => cache.get(key) === p && cache.delete(key),
    );
  }
  return p;
}

/** Forgets a backend's list (Retry, the backend says its models changed) and tells the readers. */
export function invalidateBackendModels(backendId: string): void {
  cache.delete(backendId);
  for (const listener of Array.from(invalidated)) listener();
}

/** Runs `listener` after any `invalidateBackendModels`. */
export function onBackendModelsInvalidated(listener: () => void): () => void {
  invalidated.add(listener);
  return () => void invalidated.delete(listener);
}

export const resetBackendModelsForTests = () => {
  cache.clear();
  invalidated.clear();
};
