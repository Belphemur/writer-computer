/**
 * The agent roles registry on the TypeScript side: `shared/agent-roles.json`, the one definition
 * Rust reads too (`src-tauri/src/agent/roles.rs`; ADR "Define agent roles once and map them to each
 * agent backend through adapters", spec `SPECs/agent-roles-spec.md`). TypeScript never resolves a
 * tier to a model or renders a role: Rust does, in the backend's adapter. This module only names
 * what the UI needs: the tiers (one model setting per tier and backend) and the roles of a tier.
 */
import registry from "@shared/agent-roles.json";

export type AgentRole = (typeof registry.roles)[number];

/** `cheap`, `standard`, `strong`: the order the settings page lists them in. */
export const AGENT_TIERS: readonly string[] = registry.tiers;

export const AGENT_ROLES: readonly AgentRole[] = registry.roles;

/** The Claude backend's model setting for a tier (`agent.claude.model-cheap`, ...). Each backend
 *  owns its keys in its feature's settings fragment; Claude is the only backend today. */
export const claudeTierSettingKey = (tier: string): string => `agent.claude.model-${tier}`;
