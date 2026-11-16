// VaultIo on top of the app's existing fs commands (the same ones src/lib/tauri.ts wraps).
//
// Limits: Rust scopes these commands to the workspace root; `read_directory` hides dotfiles;
// there is no binary read/write command yet, so readBinary/writeBinary are not provided.
import { invoke } from "@tauri-apps/api/core";
import type { DirEntry, FileContent } from "@/types/fs";
import { traceIpc } from "../ipc-trace";
import type { VaultEntry, VaultIo, VaultStat } from "./vault";

const call = <T>(cmd: string, args: Record<string, unknown>): Promise<T> =>
  traceIpc(cmd, () => invoke<T>(cmd, args));

interface ProbeEntry {
  exists: boolean;
  is_file: boolean;
  is_dir: boolean;
  size: number | null;
  /** Unix ms; absent from an older backend (then the stat reports 0, as for hidden entries). */
  modified_ms?: number | null;
  created_ms?: number | null;
}

/**
 * Stat for an entry the directory listing does not show (hidden or non-markdown). The listing is
 * lossy, so the kind must come from the filesystem: guessing "file" turned folders such as
 * `copilot/skills` into files and broke every later child insertion.
 */
export function statFromProbe(p: ProbeEntry | undefined): VaultStat {
  return {
    type: p?.is_dir ? "folder" : "file",
    ctime: p?.created_ms ?? 0,
    mtime: p?.modified_ms ?? 0,
    size: p?.size ?? 0,
  };
}

/** `root` is the absolute workspace root; `name` the vault display name. */
export function createTauriVaultIo(root: string, name: string): VaultIo {
  const base = root.replace(/\/+$/, "");
  const abs = (rel: string): string => (rel === "" ? base : `${base}/${rel}`);
  const rel = (absPath: string): string => absPath.replace(/\\/g, "/").slice(base.length + 1);
  const listDir = async (dir: string): Promise<VaultEntry[]> =>
    // `titles: false`: the plugin vault never shows sidebar titles, and extracting them opens
    // every markdown file of the folder.
    (await call<DirEntry[]>("read_directory", { path: abs(dir), titles: false })).map((e) => ({
      name: e.name,
      path: rel(e.path),
      isDir: e.is_dir,
      mtime: e.modified_at * 1000,
      ctime: e.created_at * 1000,
      size: 0,
    }));
  return {
    basePath: base,
    name,
    async readText(path) {
      return (await call<FileContent>("read_file", { path: abs(path) })).content;
    },
    async writeText(path, content) {
      await call("write_file", { path: abs(path), content });
    },
    list: listDir,
    async stat(path): Promise<VaultStat | null> {
      if (path === "") return { type: "folder", ctime: 0, mtime: 0, size: 0 };
      // One O(1) probe. This used to be `file_exists` plus a listing of the parent folder (one
      // title read per markdown file in it) for every stat, exists, modify and watcher event.
      const [probe] = await call<ProbeEntry[]>("plugin_fs_probe", { paths: [abs(path)] });
      return probe?.exists ? statFromProbe(probe) : null;
    },
    async mkdir(path) {
      await call("create_directory", { path: abs(path) });
    },
    async rename(from, to) {
      await call("rename_entry", { oldPath: abs(from), newPath: abs(to) });
    },
    async remove(path) {
      await call("delete_entry", { path: abs(path) });
    },
  };
}
