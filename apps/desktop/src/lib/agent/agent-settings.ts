/**
 * `AgentSettings` for `StartSessionRequest`, read from the flat settings record. The `agent.*`
 * keys and their defaults live in `shared/settings.schema.json` (one contract for Rust and TS);
 * nothing here repeats a default.
 */
import { SETTINGS_SCHEMA } from "@/lib/settings-schema";
import type { AgentPermissionMode, AgentSettings } from "./events";

const MODES: readonly AgentPermissionMode[] = ["manual", "acceptEdits", "plan", "auto", "dontAsk"];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/** The default of an `agent.*` key: `shared/settings.schema.json` is the one source of truth. */
export function agentSettingDefault(key: string): unknown {
  return SETTINGS_SCHEMA.find((d) => d.key === key)?.default;
}

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

export function agentSettingsFrom(settings: Record<string, unknown>): AgentSettings {
  const mode = read(settings, "agent.permission-mode");
  const effort = read(settings, "agent.effort");
  return {
    binaryPath: str(read(settings, "agent.binary-path")),
    model: str(read(settings, "agent.model")),
    effort: (EFFORTS as readonly unknown[]).includes(effort)
      ? (effort as AgentSettings["effort"])
      : null,
    permissionMode: (MODES as readonly unknown[]).includes(mode)
      ? (mode as AgentPermissionMode)
      : "manual",
    allowedTools: list(read(settings, "agent.allowed-tools")),
    disallowedTools: list(read(settings, "agent.disallowed-tools")),
    orchestrate: read(settings, "agent.orchestrate") !== false,
    subagentModel: str(read(settings, "agent.subagent-model")),
  };
}

export const PERMISSION_MODE_LABEL: Record<AgentPermissionMode, string> = {
  manual: "Ask before edit",
  acceptEdits: "Auto-edit files",
  plan: "Plan only",
  auto: "Auto",
  dontAsk: "Don't ask",
};
