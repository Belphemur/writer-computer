/**
 * The registry of agent backends shown in Settings > Agent (spec "Other backends"). Claude is the
 * only backend that exists; the others are listed as "Coming soon" so adding one is a registry
 * entry (descriptor, detect command, models source) plus a Rust mapper, not a UI change. The Rust
 * side keeps its own `backend` field (`claude` today, `AgentBackendId` in `events.ts`).
 */
import type { AgentBinaryInfo } from "./events";

export type BackendGlyph = "claude" | "opencode" | "codex";

export type AgentBackendDescriptor = {
  id: string;
  label: string;
  glyph: BackendGlyph;
  /** `coming-soon` backends render as disabled pills and never reach the runner. */
  status: "available" | "coming-soon";
  /** The Tauri command that finds this backend's program; null while there is none. */
  detectCommand: "agent_detect_binary" | null;
  /** Where its model list comes from: Claude's cannot be discovered from stream-json. */
  modelsSource: "static-catalog" | "none";
  installUrl: string | null;
  /** Oldest version verified against Writer's protocol mapper. */
  minVersion: string | null;
};

export const AGENT_BACKENDS: readonly AgentBackendDescriptor[] = [
  {
    id: "opencode",
    label: "OpenCode",
    glyph: "opencode",
    status: "coming-soon",
    detectCommand: null,
    modelsSource: "none",
    installUrl: null,
    minVersion: null,
  },
  {
    id: "claude",
    label: "Claude",
    glyph: "claude",
    status: "available",
    detectCommand: "agent_detect_binary",
    modelsSource: "static-catalog",
    installUrl: "https://code.claude.com/docs/en/quickstart",
    minVersion: "2.1.325",
  },
  {
    id: "codex",
    label: "Codex",
    glyph: "codex",
    status: "coming-soon",
    detectCommand: null,
    modelsSource: "none",
    installUrl: null,
    minVersion: null,
  },
];

export const DEFAULT_BACKEND_ID = "claude";

export function backendById(id: string): AgentBackendDescriptor | undefined {
  return AGENT_BACKENDS.find((b) => b.id === id);
}

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
export type DetectedBinary = AgentBinaryInfo;

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
  const have = parseVersion(info.version);
  const min = parseVersion(backend.minVersion);
  if (have && min && compareVersions(have, min) < 0) {
    return {
      kind: "unsupported-version",
      path: info.path,
      version: have.join("."),
      minVersion: min.join("."),
    };
  }
  if (info.authenticated === false) return { kind: "needs-sign-in", path: info.path };
  return { kind: "ready", path: info.path, version: info.version };
}
