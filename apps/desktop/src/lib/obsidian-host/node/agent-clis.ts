// The agent CLIs Copilot Agent Mode (4.0.20) can drive, and the paths its SYNCHRONOUS detection
// probes (`existsSync` over a candidate list, see its claude/codex/opencode binary resolvers).
// WKWebView cannot block on IPC, so the host preloads these into the sync fs cache at boot
// (`registerSyncProbePaths`); a path that is not listed here reads as missing to `existsSync`.
// Single source of truth: add an agent here and boot, the probe allow-list in Rust
// (`plugin_env::ProbeScope`) and the e2e fixture all follow.
import { createFsModule } from "./fs";
import { posix } from "./path";

/** Executable names looked up on PATH: Claude Code, Codex's ACP adapter and CLI, OpenCode. */
export const AGENT_CLI_NAMES = ["claude", "codex", "codex-acp", "opencode"] as const;

/** Copilot's `WELL_KNOWN_BIN_DIRS`. */
const WELL_KNOWN_BIN_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];

/** Node version managers keep installs under these roots (names are listed by the probe). */
export const versionRoots = (home: string): { root: string; bin: string[] }[] => [
  { root: posix.join(home, ".nvm/versions/node"), bin: ["bin"] },
  { root: posix.join(home, ".local/share/fnm/node-versions"), bin: ["installation", "bin"] },
  {
    root: posix.join(home, "Library/Application Support/fnm/node-versions"),
    bin: ["installation", "bin"],
  },
];

/** Directories whose `<name>` entries Copilot's resolvers stat, in a plausible install order. */
export function agentBinDirs(home: string, loginPath: string): string[] {
  const dirs = [
    ...loginPath.split(":").filter((d) => d.startsWith("/")),
    ...WELL_KNOWN_BIN_DIRS,
    posix.join(home, ".local/bin"),
    posix.join(home, ".claude/local"),
    posix.join(home, ".codex-acp/bin"),
    posix.join(home, ".opencode/bin"),
    posix.join(home, ".bun/bin"),
    posix.join(home, ".npm-global/bin"),
    posix.join(home, ".volta/bin"),
    posix.join(home, ".asdf/shims"),
    posix.join(home, ".asdf/bin"),
  ];
  return [...new Set(dirs)];
}

/** Every `<dir>/<agent cli>` candidate for `dirs`. */
export const agentCandidates = (dirs: readonly string[]): string[] =>
  dirs.flatMap((d) => AGENT_CLI_NAMES.map((n) => posix.join(d, n)));

/**
 * Absolute paths a user already configured for an agent CLI (Copilot keeps them under
 * `agentMode` in data.json: `claudeCliPath`, codex/opencode adapter paths, ...). A program outside
 * PATH and the well-known dirs is only visible to the sync fs cache once it was vouched for with
 * `plugin_which`, which a typed path gets when the user saves it; after a restart this restores
 * that, so a custom Codex or OpenCode location is still detected. Pure; capped.
 */
export function configuredAgentPaths(dataJson: string | null | undefined): string[] {
  if (!dataJson) return [];
  let root: unknown;
  try {
    root = (JSON.parse(dataJson) as { agentMode?: unknown }).agentMode;
  } catch {
    return [];
  }
  const out = new Set<string>();
  const walk = (v: unknown, key: string, depth: number): void => {
    if (out.size >= 32 || depth > 6) return;
    if (typeof v === "string") {
      if (/(path|command|binary)$/i.test(key) && /^\/[^\0\n]{1,1023}$/.test(v)) out.add(v);
    } else if (v && typeof v === "object")
      for (const [k, x] of Object.entries(v)) walk(x, k, depth + 1);
  };
  walk(root, "", 0);
  return [...out];
}

/** Vouches for each configured program (see `configuredAgentPaths`); never rejects. */
export async function primeConfiguredAgentPaths(paths: readonly string[]): Promise<void> {
  const { promises } = createFsModule();
  await Promise.all(paths.map((p) => promises.stat(p).catch(() => undefined)));
}
