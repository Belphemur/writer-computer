// A second agent backend for the pane's tests, registered the way a feature does (the
// `agent.backends` point), so the neutral agent code is tested without naming a real backend.
import {
  agentBackendContributions,
  type AgentBackendContribution,
  type BackendModel,
} from "@/lib/features/agent-backends";

export const FIXTURE_ID = "fixture-live";
export const FIXTURE_OWNER = "builtin:fixture-live";

export const FIXTURE_MODELS: BackendModel[] = [
  {
    id: "acme/big",
    label: "Big",
    provider: "Acme",
    variants: ["none", "low", "high"],
    available: true,
  },
  { id: "acme/plain", label: "Plain", provider: "Acme", variants: [], available: true },
  { id: "acme/off", label: "Switched off", provider: "Acme", variants: ["low"], available: true },
  { id: "acme/gone", label: "Gone", provider: "Acme", variants: [], available: false },
];

export const FIXTURE_KEYS = {
  binaryPath: "fixture.binary-path",
  model: "fixture.model",
  effort: "fixture.effort",
  disabledModels: "fixture.disabled-models",
  tiers: {
    cheap: "fixture.model-cheap",
    standard: "fixture.model-standard",
    strong: "fixture.model-strong",
  },
};

export function fixtureBackend(
  over: Partial<AgentBackendContribution> = {},
): AgentBackendContribution {
  return {
    id: "fixture-live.backend",
    backendId: FIXTURE_ID,
    label: "Fixture",
    glyph: "F",
    program: "fixture-agent",
    installUrl: "https://example.test/install",
    signIn: { hint: "Sign in to the fixture.", command: "fixture login" },
    keys: FIXTURE_KEYS,
    detect: async () => ({ found: true, path: "/synthetic/bin/fixture-agent", version: "1.0.0" }),
    models: async () => FIXTURE_MODELS,
    settingsPanel: async () => () => null,
    toolTable: { fallback: { kind: "other" }, tools: [] },
    ...over,
  };
}

/** Registers the fixture backend; the returned function removes it. */
export function registerFixtureBackend(over: Partial<AgentBackendContribution> = {}): () => void {
  const c = fixtureBackend(over);
  return agentBackendContributions.add(c.id, { ...c, owner: FIXTURE_OWNER });
}
