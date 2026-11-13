// Shared runtime state of the Node surface: the injected IPC, the os snapshot, the vault base
// path, the pid table (process.kill) and the sync-fs probe cache. Filled by `preloadNodeRuntime`
// (runtime.ts) before any plugin script runs; every shim reads it lazily.
import { tauriNodeIpc, type FsProbe, type NodeIpc, type NodeOsInfo } from "./ipc";

export const DEFAULT_OS_INFO: NodeOsInfo = Object.freeze({
  platform: "darwin",
  arch: "arm64",
  homedir: "/",
  username: "user",
  shell: "/bin/sh",
  tmpdir: "/tmp",
  env: Object.freeze({}) as Record<string, string>,
}) as NodeOsInfo;

let ipc: NodeIpc | null = null;
let osInfo: NodeOsInfo = DEFAULT_OS_INFO;
let basePath = "/";

/** Test seam / host injection. `null` restores the Tauri-backed IPC. */
export function setNodeIpc(next: NodeIpc | null): void {
  ipc = next;
}
export const getNodeIpc = (): NodeIpc => ipc ?? tauriNodeIpc;

export function setOsInfo(info: NodeOsInfo | null): void {
  osInfo = info ?? DEFAULT_OS_INFO;
}
export const getOsInfo = (): NodeOsInfo => osInfo;

export function setBasePath(path: string): void {
  basePath = path.length > 1 ? path.replace(/\/+$/, "") : path;
}
export const getBasePath = (): string => basePath;

// ---------------------------------------------------------------- pid table

/** What `process.kill(pid)` needs from a live child. */
export interface PidEntry {
  killProc(signal: string | number, group: boolean): boolean;
}
const pidTable = new Map<number, PidEntry>();
export const registerPid = (pid: number, entry: PidEntry): void => void pidTable.set(pid, entry);
export const unregisterPid = (pid: number, entry: PidEntry): void => {
  if (pidTable.get(pid) === entry) pidTable.delete(pid);
};
export const lookupPid = (pid: number): PidEntry | undefined => pidTable.get(pid);

// ---------------------------------------------------------------- sync probe cache

const probeCache = new Map<string, FsProbe>();
const contentCache = new Map<string, string>();
export const syncProbeCache = probeCache;
export const syncContentCache = contentCache;

export function resetNodeRuntimeForTests(): void {
  ipc = null;
  osInfo = DEFAULT_OS_INFO;
  basePath = "/";
  pidTable.clear();
  probeCache.clear();
  contentCache.clear();
}
