// Boot and global installation of the Node surface.
//   preloadNodeRuntime: one-time async fetch of os info, the login PATH and the sync-fs probe
//   cache. The loader awaits it before any plugin script evaluates.
//   installNodeGlobals: ref-counted install of `process`, `Buffer` and `require` as globals while
//   at least one plugin is loaded (Copilot's esbuild banner only defines a fallback `process` when
//   `globalThis.process` is missing, so the global must be real BEFORE the script runs).
import { Buffer } from "./buffer";
import { messageOf } from "./errors";
import type { NodeIpc, NodeOsInfo } from "./ipc";
import { AGENT_CLI_NAMES, agentBinDirs, agentCandidates, versionRoots } from "./agent-clis";
import { registerSyncProbePaths } from "./fs";
import { posix } from "./path";
import { applyOsInfo, getSharedProcess } from "./process";
import {
  DEFAULT_OS_INFO,
  getNodeIpc,
  setBasePath,
  setNodeIpc,
  setOsInfo,
  syncProbeCache,
} from "./state";

export interface PreloadOptions {
  /** Injected backend (tests); omitted = keep the current one (Tauri by default). */
  ipc?: NodeIpc;
  /** Absolute vault root: process.cwd(), the base of path.resolve, the sync-probe root. */
  basePath: string;
  /** Extra absolute paths to probe for the sync fs cache. */
  extraProbePaths?: readonly string[];
}

const hasTauri = (): boolean => "__TAURI_INTERNALS__" in globalThis;

/** Never rejects: every step degrades to defaults and logs once (outside a Tauri window: silent). */
export async function preloadNodeRuntime(options: PreloadOptions): Promise<void> {
  if (options.ipc) setNodeIpc(options.ipc);
  setBasePath(options.basePath);
  const ipc = getNodeIpc();
  const loud = options.ipc !== undefined || hasTauri();
  const warn = (what: string, e: unknown): void => {
    if (loud) console.warn(`[plugin-node] ${what} failed: ${messageOf(e)}`);
  };

  let info = DEFAULT_OS_INFO;
  try {
    const raw = (await ipc.osInfo()) as Partial<NodeOsInfo> | null | undefined;
    if (!raw || typeof raw !== "object") throw new Error("unexpected response");
    info = { ...DEFAULT_OS_INFO, ...raw, env: { ...raw.env } };
  } catch (e) {
    warn("plugin_os_info", e);
  }
  const env = { ...info.env };
  try {
    const loginPath = await ipc.resolveLoginPath();
    if (loginPath) env.PATH = loginPath;
  } catch (e) {
    warn("plugin_resolve_login_path", e);
  }
  setOsInfo({ ...info, env });
  applyOsInfo(getSharedProcess());

  const found: string[] = [];
  let whichFailure: unknown;
  for (const name of AGENT_CLI_NAMES) {
    try {
      const p = await ipc.which(name);
      if (p) found.push(p);
    } catch (e) {
      whichFailure ??= e;
    }
  }
  if (whichFailure !== undefined) warn("plugin_which", whichFailure);
  const home = info.homedir;
  const dirs = agentBinDirs(home, env.PATH ?? "");
  const paths = [
    options.basePath,
    posix.join(home, ".claude"),
    posix.join(home, ".claude", "settings.json"),
    posix.join(home, ".codex"),
    posix.join(home, ".obsidian-copilot"),
    ...agentCandidates(dirs),
    ...found,
    ...(options.extraProbePaths ?? []),
  ];
  try {
    await registerSyncProbePaths([...paths, ...versionRoots(home).map((r) => r.root)]);
    // npm-installed agents live in <root>/<version>/bin; the resolvers enumerate the roots with
    // readdirSync (answered from the listing the probe returned) and then stat these.
    const nodeBins = versionRoots(home).flatMap(({ root, bin }) =>
      (syncProbeCache.get(root)?.entries ?? []).map((v) => posix.join(root, v, ...bin)),
    );
    if (nodeBins.length > 0)
      await registerSyncProbePaths([...nodeBins, ...agentCandidates(nodeBins)]);
  } catch (e) {
    warn("plugin_fs_probe", e);
  }
}

// ---------------------------------------------------------------- globals

interface Installed {
  count: number;
  saved: Map<string, PropertyDescriptor | undefined>;
  ours: Map<string, unknown>;
  /** Uninstaller for `window` when it is a different object than the target. */
  windowUninstall: (() => void) | null;
}
const installs = new WeakMap<object, Installed>();

/**
 * Installs `process`, `Buffer` and `require` on `target` (default `globalThis`) and returns an
 * idempotent uninstaller; the originals come back when the last installer uninstalls. A real
 * Node `process` (`versions.node` present: test environments) is never replaced.
 */
export function installNodeGlobals(
  require: (id: string) => unknown,
  target: object = globalThis,
): () => void {
  let state = installs.get(target);
  if (!state) {
    const t = target as Record<string, unknown>;
    const realNode =
      (t.process as { versions?: { node?: string } } | undefined)?.versions?.node !== undefined;
    const values: Record<string, unknown> = { require };
    if (!realNode) {
      values.process = getSharedProcess();
      values.Buffer = Buffer;
    }
    // WebKit only exposes SharedArrayBuffer when cross-origin isolated; the SDK constructs one at
    // module scope (`new Int32Array(new SharedArrayBuffer(4))`), so stand in with ArrayBuffer.
    if (t.SharedArrayBuffer === undefined) values.SharedArrayBuffer = ArrayBuffer;

    state = { count: 0, saved: new Map(), ours: new Map(), windowUninstall: null };
    for (const [key, value] of Object.entries(values)) {
      state.saved.set(key, Object.getOwnPropertyDescriptor(target, key));
      Object.defineProperty(target, key, {
        value,
        writable: true,
        configurable: true,
        enumerable: false,
      });
      state.ours.set(key, value);
    }
    installs.set(target, state);
    // `window.require` must exist too (Copilot checks it); same object in browsers, distinct in jsdom.
    const win = t.window as object | undefined;
    if (win && typeof win === "object" && win !== target)
      state.windowUninstall = installNodeGlobals(require, win);
  }
  state.count++;
  const mine = state;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (--mine.count > 0) return;
    installs.delete(target);
    mine.windowUninstall?.();
    for (const [key, ours] of mine.ours) {
      if ((target as Record<string, unknown>)[key] !== ours) continue; // someone replaced it since
      const original = mine.saved.get(key);
      if (original) Object.defineProperty(target, key, original);
      else delete (target as Record<string, unknown>)[key];
    }
  };
}
