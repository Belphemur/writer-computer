/**
 * `AgentSettings` for `StartSessionRequest`, read from the flat settings record. The `agent.*`
 * keys and their defaults live in `shared/settings.schema.json` (one contract for Rust and TS);
 * nothing here repeats a default.
 */
import { EFFORT_LEVELS } from "@/lib/features/agent-backends";
import { agentSettingDefault } from "./setting-default";

export { agentSettingDefault };
import { AGENT_TIERS } from "./agent-roles";
import { backendOrDefault, DEFAULT_BACKEND_ID, type AgentBackendDescriptor } from "./backends";
import type { AgentMemory, AgentPermissionMode, AgentSettings } from "./events";

const MODES: readonly AgentPermissionMode[] = ["manual", "acceptEdits", "plan", "auto", "dontAsk"];
const MEMORIES: readonly AgentMemory[] = ["vault", "default", "off"];

/** A stored value, or the schema default while settings have not hydrated or hold a bad value. */
function read(settings: Record<string, unknown>, key: string): unknown {
  return key in settings ? settings[key] : agentSettingDefault(key);
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const list = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "")
    : typeof v === "string"
      ? v
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

/** A chat's own model and effort (null model: "Agent default", no `--model`). */
export type ChatModelChoice = { model: string | null; effort: AgentSettings["effort"] };

/** `backend`: the descriptor of the chat's backend, whose keys hold the program, model, effort and
 *  tier models (the permission, memory and display settings are shared). Absent: Claude's. */
export function agentSettingsFrom(
  settings: Record<string, unknown>,
  backend: AgentBackendDescriptor = backendOrDefault(DEFAULT_BACKEND_ID),
): AgentSettings {
  const keys = backend.keys;
  const mode = read(settings, "agent.permission-mode");
  const effort = read(settings, keys.effort);
  const memory = read(settings, "agent.memory");
  return {
    binaryPath: str(read(settings, keys.binaryPath)),
    model: str(read(settings, keys.model)),
    effort: (EFFORT_LEVELS as readonly unknown[]).includes(effort)
      ? (effort as AgentSettings["effort"])
      : null,
    permissionMode: (MODES as readonly unknown[]).includes(mode)
      ? (mode as AgentPermissionMode)
      : "manual",
    allowedTools: list(read(settings, "agent.allowed-tools")),
    disallowedTools: list(read(settings, "agent.disallowed-tools")),
    orchestrate: read(settings, "agent.orchestrate") !== false,
    showThinking: read(settings, "agent.show-thinking") !== false,
    autoReload: read(settings, "agent.auto-reload") !== false,
    memory: (MEMORIES as readonly unknown[]).includes(memory)
      ? (memory as AgentMemory)
      : (agentSettingDefault("agent.memory") as AgentMemory),
    // One stored value per tier; Rust resolves them (blank means the tier's default model).
    tierModels: Object.fromEntries(
      AGENT_TIERS.map((tier) => [tier, str(read(settings, keys.tiers[tier] ?? ""))]),
    ),
  };
}

export const PERMISSION_MODE_LABEL: Record<AgentPermissionMode, string> = {
  manual: "Ask before edit",
  acceptEdits: "Auto-edit files",
  plan: "Plan only",
  auto: "Auto",
  dontAsk: "Don't ask",
};
