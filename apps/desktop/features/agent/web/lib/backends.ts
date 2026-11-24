/**
 * The agent backends the pane can use (spec "Other backends"): Claude is the built-in entry, the
 * contributed ones come from the `agent.backends` point (`@/lib/features/agent-backends`, while
 * their feature is on) and Codex stays "coming soon". Everything backend-specific the neutral code
 * needs (settings keys, program name, detection, model list, tool table) is on the descriptor, so a
 * new backend is a contribution, never a branch here. Rust keeps its own `backend` id (`events.ts`).
 */
import { useMemo } from "react";
import { useRegistryItems } from "@/hooks/use-registry-items";
import {
  agentBackendContributions,
  type AgentBackendContribution,
  type BackendModel,
  type BackendSettingKeys,
  type DetectedProgram,
  type OwnedAgentBackend,
} from "@/lib/features/agent-backends";
import type { AgentBinaryInfo } from "./events";
import { agentSettingDefault } from "./setting-default";
import { claudeTierSettingKey, AGENT_TIERS } from "./agent-roles";
import { createTauriAgentClient, type AgentClient } from "./client";

export type BackendGlyph = string;

export type AgentBackendDescriptor = {
  id: string;
  label: string;
  /** The product the program belongs to, for sentences ("Claude Code"). */
  product: string;
  /** `claude` draws the spark, anything else a tile with this letter. */
  glyph: BackendGlyph;
  /** `coming-soon` backends render as disabled pills and never reach the runner. */
  status: "available" | "coming-soon";
  /** The program's name, for status text. */
  program: string;
  installUrl: string | null;
  /** Oldest version verified against Writer's protocol mapper; null where the backend's detection
   *  says it (`DetectedProgram.supported` / `minVersion`). */
  minVersion: string | null;
  keys: BackendSettingKeys;
  /** What the "sign in required" card says and the command it copies. */
  signIn: { hint: string; command: string };
  /** Added to the shell approval card after its neutral line. */
  shellNote?: string;
  /** Where its model list comes from: Claude's cannot be discovered (a static catalog). */
  modelsSource: "static-catalog" | "live" | "none";
  /** Is the chat id also the backend's session id (Claude's `--session-id`)? Else the id is the
   *  backend's own (`ses_...`) and a chat that never started one has none to resume. */
  chatIdIsSession: boolean;
  /** Does a changed effort restart the session (Claude) or apply live? */
  effortRestarts: boolean;
  /** Absent (Claude): the agent's own `agent_detect_binary`. */
  detect?: AgentBackendContribution["detect"];
  models?: AgentBackendContribution["models"];
  settingsPanel?: AgentBackendContribution["settingsPanel"];
  toolTable?: unknown;
  /** The feature that contributed it (error boundary of its panel). */
  owner?: string;
};

/** The backend a chat without a choice uses: the schema default of `agent.default-backend`. */
export const DEFAULT_BACKEND_ID = agentSettingDefault("agent.default-backend") as string;

const CLAUDE: AgentBackendDescriptor = {
  id: DEFAULT_BACKEND_ID,
  label: "Claude",
  product: "Claude Code",
  glyph: "claude",
  status: "available",
  program: "claude",
  installUrl: "https://code.claude.com/docs/en/quickstart",
  minVersion: "2.1.325",
  signIn: { hint: "Run `claude` in a terminal and type /login, then retry.", command: "claude" },
  keys: {
    binaryPath: "agent.binary-path",
    model: "agent.model",
    effort: "agent.effort",
    tiers: Object.fromEntries(AGENT_TIERS.map((t) => [t, claudeTierSettingKey(t)])),
  },
  modelsSource: "static-catalog",
  chatIdIsSession: true,
  effortRestarts: true,
};

const CODEX: AgentBackendDescriptor = {
  id: "codex",
  label: "Codex",
  product: "Codex",
  glyph: "X",
  status: "coming-soon",
  program: "codex",
  installUrl: null,
  minVersion: null,
  signIn: { hint: "", command: "codex" },
  keys: { ...CLAUDE.keys, tiers: {} },
  modelsSource: "none",
  chatIdIsSession: false,
  effortRestarts: false,
};

const fromContribution = (c: OwnedAgentBackend): AgentBackendDescriptor => ({
  id: c.backendId,
  label: c.label,
  product: c.label,
  glyph: c.glyph,
  status: "available",
  program: c.program,
  installUrl: c.installUrl,
  minVersion: null,
  keys: c.keys,
  signIn: c.signIn,
  shellNote: c.shellNote,
  modelsSource: "live",
  chatIdIsSession: false,
  effortRestarts: false,
  detect: c.detect,
  models: c.models,
  settingsPanel: c.settingsPanel,
  toolTable: c.toolTable,
  owner: c.owner,
});

const built = new WeakMap<OwnedAgentBackend, AgentBackendDescriptor>();
const descriptorOf = (c: OwnedAgentBackend) => {
  let d = built.get(c);
  if (!d) built.set(c, (d = fromContribution(c)));
  return d;
};

const assemble = (items: readonly OwnedAgentBackend[]): AgentBackendDescriptor[] => [
  CLAUDE,
  ...items.map(descriptorOf),
  CODEX,
];

/** Every backend, now: Claude, the registered ones, then the "coming soon" ones. */
export const listBackends = (): AgentBackendDescriptor[] =>
  assemble(agentBackendContributions.list());

/** The same list, re-read when a feature is turned on or off. */
export function useBackends(): AgentBackendDescriptor[] {
  const items = useRegistryItems(agentBackendContributions);
  return useMemo(() => assemble(items), [items]);
}

export function backendById(id: string): AgentBackendDescriptor | undefined {
  return listBackends().find((b) => b.id === id);
}

/** The descriptor whose keys a chat of backend `id` reads; unknown (its feature is off): Claude's,
 *  and the start is rejected by Rust with the reason. */
export const backendOrDefault = (id: string | null | undefined): AgentBackendDescriptor =>
  (id ? backendById(id) : undefined) ?? CLAUDE;

/** Does a chat of backend `id` start with its chat id as the session id? An unknown backend (its
 *  feature is off) has no such session: its notes resume only by the id they stored. */
export const chatIdIsSession = (id: string | null | undefined): boolean =>
  (id ? backendById(id)?.chatIdIsSession : undefined) ?? false;

const detecting = new Map<string, Promise<DetectedProgram>>();

/** Program detection through the descriptor; a backend with no `detect` of its own (Claude) uses
 *  the agent's `agent_detect_binary` through `client`. A call for the same program while one is
 *  running shares it (the pane, Settings and the usability check all ask at startup). */
export function detectBackend(
  backend: AgentBackendDescriptor,
  binaryOverride: string | null,
  client: Pick<AgentClient, "detectBinary"> = createTauriAgentClient(),
): Promise<DetectedProgram> {
  const key = `${backend.id}\0${binaryOverride ?? ""}`;
  let p = detecting.get(key);
  if (!p) {
    p = detectOnce(backend, binaryOverride, client).finally(() => detecting.delete(key));
    detecting.set(key, p);
  }
  return p;
}

async function detectOnce(
  backend: AgentBackendDescriptor,
  binaryOverride: string | null,
  client: Pick<AgentClient, "detectBinary"> = createTauriAgentClient(),
): Promise<DetectedProgram> {
  if (backend.status !== "available") {
    return Promise.reject(new Error(`${backend.label} cannot be detected`));
  }
  return backend.detect ? backend.detect(binaryOverride) : client.detectBinary({ binaryOverride });
}

export type { BackendModel, DetectedProgram };

/** `2.1.325 (Claude Code)` or `2.1.325` to [2, 1, 325]; null when there is no version. */
export function parseVersion(text: string | null | undefined): number[] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text ?? "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

/** The detection result; `authenticated` is reported by the backend (`null` = unknown). */
export type DetectedBinary = DetectedProgram | AgentBinaryInfo;

export type BackendStatus =
  | { kind: "checking" }
  | { kind: "ready"; path: string; version: string | null }
  | { kind: "not-found" }
  | { kind: "needs-sign-in"; path: string }
  | { kind: "unsupported-version"; path: string; version: string; minVersion: string }
  | { kind: "error"; message: string };

/** One pure function from a detection result to the badge. */
export function deriveBackendStatus(
  backend: Pick<AgentBackendDescriptor, "minVersion">,
  info: DetectedBinary | null,
  error: string | null,
): BackendStatus {
  if (error) return { kind: "error", message: error };
  if (!info) return { kind: "checking" };
  if (!info.found || !info.path) return { kind: "not-found" };
  // the backend's own verdict wins; without one the descriptor's oldest version decides
  const said = info.supported;
  const have = parseVersion(info.version);
  const min = parseVersion(info.minVersion || backend.minVersion);
  const unsupported =
    typeof said === "boolean" ? !said : have && min ? compareVersions(have, min) < 0 : false;
  if (unsupported) {
    return {
      kind: "unsupported-version",
      path: info.path,
      version: have?.join(".") ?? info.version ?? "unknown",
      minVersion: min?.join(".") ?? "",
    };
  }
  if (info.authenticated === false) return { kind: "needs-sign-in", path: info.path };
  return { kind: "ready", path: info.path, version: info.version };
}
