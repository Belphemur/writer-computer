// Backend boundary of the Node surface (child processes, os info, fs probes). The Rust side owns
// consent, confinement and the real OS calls; the shims only talk to it through `NodeIpc` so
// tests can fake it. Wire shapes mirror the `plugin_proc_*` / `plugin_which` / `plugin_os_info` /
// `plugin_fs_probe` commands.
import { Channel, invoke } from "@tauri-apps/api/core";

export type ProcEvent =
  | { type: "spawn"; pid: number }
  | { type: "stdout" | "stderr"; data_base64: string }
  | { type: "exit"; code: number | null; signal: string | null }
  | { type: "error"; code: string; message: string };

export interface ProcSpawnRequest {
  plugin_id: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: "pipe" | "ignore";
  inherit_env?: boolean;
}

export type ProcSignal = "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGHUP";

export interface NodeOsInfo {
  platform: string;
  arch: string;
  homedir: string;
  username: string;
  shell: string;
  tmpdir: string;
  env: Record<string, string>;
}

export interface FsProbe {
  path: string;
  exists: boolean;
  is_file: boolean;
  is_dir: boolean;
  size: number | null;
  /** Entry names; only for node-tool version roots (nvm / fnm), see Rust `ProbeResult`. */
  entries?: string[];
  /** Canonical path (symlinks resolved) of an existing entry. */
  real?: string;
  /** Content of a package-metadata companion file (provenance.json / package.json) of a `which` program. */
  text?: string;
}

export interface NodeIpc {
  /** Resolves with the proc id. Events may be delivered before it resolves. */
  procSpawn(request: ProcSpawnRequest, onEvent: (ev: ProcEvent) => void): Promise<number>;
  procWrite(procId: number, dataBase64: string): Promise<void>;
  procCloseStdin(procId: number): Promise<void>;
  procKill(procId: number, signal?: ProcSignal, group?: boolean): Promise<void>;
  which(name: string): Promise<string | null>;
  resolveLoginPath(): Promise<string>;
  osInfo(): Promise<NodeOsInfo>;
  fsProbe(paths: string[]): Promise<FsProbe[]>;
  /** `shell.openExternal`: Rust validates the scheme (http, https, mailto). */
  openUrl(url: string): Promise<void>;
  /** `shell.openPath` / `showItemInFolder`: Rust confines to the vault and agent config folders. */
  openPath(path: string, reveal: boolean): Promise<void>;
}

export const tauriNodeIpc: NodeIpc = {
  procSpawn: (request, onEvent) => {
    const channel = new Channel<ProcEvent>();
    channel.onmessage = onEvent;
    return invoke<number>("plugin_proc_spawn", { request, onEvent: channel });
  },
  procWrite: (procId, dataBase64) => invoke("plugin_proc_write", { procId, dataBase64 }),
  procCloseStdin: (procId) => invoke("plugin_proc_close_stdin", { procId }),
  procKill: (procId, signal, group) => invoke("plugin_proc_kill", { procId, signal, group }),
  which: (name) => invoke("plugin_which", { name }),
  resolveLoginPath: () => invoke("plugin_resolve_login_path"),
  osInfo: () => invoke("plugin_os_info"),
  fsProbe: (paths) => invoke("plugin_fs_probe", { paths }),
  openUrl: (url) => invoke("plugin_open_url", { url }),
  openPath: (path, reveal) => invoke("plugin_open_path", { path, reveal }),
};
