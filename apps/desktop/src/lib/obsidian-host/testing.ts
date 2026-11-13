// Test doubles for the host's two boundaries (backend IPC and vault IO). Imported by tests only;
// deliberately not exported from index.ts.
import type { HostIpc, InstalledPlugin, PluginAssetKind, PluginsState } from "./ipc";
import type { PluginManifest } from "./api/core";
import type { VaultEntry, VaultIo, VaultStat } from "./api/vault";

export interface FakeIpcInit {
  trusted?: boolean;
  enabled?: string[];
  plugins?: (Partial<PluginManifest> & { id: string })[];
  styles?: Record<string, string>;
  data?: Record<string, string>;
}

export class FakeHostIpc implements HostIpc {
  trusted: boolean;
  enabled: Set<string>;
  installed: InstalledPlugin[];
  styles: Record<string, string>;
  data = new Map<string, string>();
  calls: string[] = [];

  constructor(init: FakeIpcInit = {}) {
    this.trusted = init.trusted ?? true;
    this.enabled = new Set(init.enabled ?? []);
    this.installed = (init.plugins ?? []).map((p) => ({
      id: p.id,
      manifest: { name: p.id, version: "1.0.0", ...p } as PluginManifest,
    }));
    this.styles = init.styles ?? {};
    for (const [k, v] of Object.entries(init.data ?? {})) this.data.set(k, v);
  }

  async state(): Promise<PluginsState> {
    this.calls.push("state");
    return { trusted: this.trusted, enabled: [...this.enabled], installed: this.installed };
  }
  async setTrust(trusted: boolean): Promise<void> {
    this.calls.push(`setTrust:${trusted}`);
    this.trusted = trusted;
  }
  async setEnabled(id: string, enabled: boolean): Promise<void> {
    this.calls.push(`setEnabled:${id}:${enabled}`);
    if (enabled) this.enabled.add(id);
    else this.enabled.delete(id);
  }
  async readAsset(id: string, kind: PluginAssetKind): Promise<string> {
    this.calls.push(`readAsset:${id}:${kind}`);
    if (kind === "styles") {
      const css = this.styles[id];
      if (css === undefined) throw new Error("no styles.css");
      return css;
    }
    return JSON.stringify(this.installed.find((i) => i.id === id)?.manifest ?? {});
  }
  async dataRead(id: string): Promise<string | null> {
    return this.data.get(id) ?? null;
  }
  async dataWrite(id: string, json: string): Promise<void> {
    this.calls.push(`dataWrite:${id}`);
    this.data.set(id, json);
  }
  async storeList(): Promise<unknown> {
    return [];
  }
  async storeDetail(): Promise<unknown> {
    return null;
  }
  async storeInstall(): Promise<unknown> {
    return null;
  }
  async storeUninstall(): Promise<unknown> {
    return null;
  }
}

/** In-memory VaultIo. Keys are vault-relative file paths; folders are implied plus explicit. */
export function createMemoryVaultIo(files: Record<string, string> = {}): VaultIo & {
  files: Map<string, string>;
  folders: Set<string>;
} {
  const fileMap = new Map(Object.entries(files));
  const folders = new Set<string>();
  const ensureParents = (path: string): void => {
    for (let i = path.indexOf("/"); i >= 0; i = path.indexOf("/", i + 1))
      folders.add(path.slice(0, i));
  };
  for (const p of fileMap.keys()) ensureParents(p);
  let clock = 1000;
  const mtimes = new Map<string, number>();
  const touch = (p: string): void => void mtimes.set(p, ++clock);

  return {
    files: fileMap,
    folders,
    basePath: "/vault",
    name: "vault",
    async readText(path) {
      const v = fileMap.get(path);
      if (v === undefined) throw new Error(`ENOENT: ${path}`);
      return v;
    },
    async writeText(path, content) {
      ensureParents(path);
      fileMap.set(path, content);
      touch(path);
    },
    async list(dir) {
      const prefix = dir === "" ? "" : `${dir}/`;
      const out: VaultEntry[] = [];
      const seen = new Set<string>();
      for (const p of [...fileMap.keys(), ...folders]) {
        if (!p.startsWith(prefix) || p === dir) continue;
        const rest = p.slice(prefix.length);
        const first = rest.split("/")[0];
        const full = prefix + first;
        if (seen.has(full)) continue;
        seen.add(full);
        const isDir = folders.has(full);
        out.push({
          name: first,
          path: full,
          isDir,
          mtime: mtimes.get(full) ?? 1,
          ctime: 1,
          size: fileMap.get(full)?.length ?? 0,
        });
      }
      return out;
    },
    async stat(path): Promise<VaultStat | null> {
      if (path === "" || folders.has(path)) return { type: "folder", ctime: 1, mtime: 1, size: 0 };
      const v = fileMap.get(path);
      return v === undefined
        ? null
        : { type: "file", ctime: 1, mtime: mtimes.get(path) ?? 1, size: v.length };
    },
    async mkdir(path) {
      ensureParents(`${path}/x`);
    },
    async rename(from, to) {
      const v = fileMap.get(from);
      if (v !== undefined) {
        fileMap.delete(from);
        ensureParents(to);
        fileMap.set(to, v);
        touch(to);
      } else if (folders.has(from)) {
        folders.delete(from);
        folders.add(to);
        for (const [k, val] of Array.from(fileMap)) {
          if (k.startsWith(`${from}/`)) {
            fileMap.delete(k);
            fileMap.set(`${to}/${k.slice(from.length + 1)}`, val);
          }
        }
      } else throw new Error(`ENOENT: ${from}`);
    },
    async remove(path) {
      fileMap.delete(path);
      folders.delete(path);
      for (const k of Array.from(fileMap.keys())) if (k.startsWith(`${path}/`)) fileMap.delete(k);
    },
  };
}
