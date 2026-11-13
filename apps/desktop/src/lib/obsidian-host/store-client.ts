// Typed client for the community-plugin store commands. Components and the catalog store only
// see `PluginStoreClient`, so tests can fake it; the default implementation goes through the
// seal's `hostInvoke` (never `@tauri-apps/api/core`).
import { hostInvoke } from "./seal/seal";
import type { InstalledPlugin } from "./ipc";

export interface StoreEntry {
  id: string;
  name: string;
  author: string;
  description: string;
  /** `owner/name` on GitHub. */
  repo: string;
  downloads: number;
  /** Epoch milliseconds, 0 when unknown. */
  updated: number;
}

export interface StoreLatest {
  version: string;
  tag: string;
  published: string | number | null;
}

/** Install record plus the integrity result computed by the backend. */
export interface StoreAudit {
  by?: string;
  id?: string;
  repo?: string;
  version?: string;
  tag?: string;
  installed_at?: string | number;
  files?: Record<string, { sha256?: string }>;
  /** True when every recorded file still hashes to its record. */
  intact: boolean;
}

export interface StoreDetail {
  entry: StoreEntry;
  readme: string | null;
  readme_error: string | null;
  latest: StoreLatest | null;
  release_error: string | null;
  installed: string | null;
  update: boolean;
  audit: StoreAudit | null;
}

export interface StoreInstallRecord {
  by: string;
  id: string;
  repo: string;
  version: string;
  tag: string;
  installed_at: string | number;
  files: Record<string, unknown>;
}

export interface StorePluginsState {
  trusted: boolean;
  enabled: string[];
  installed: InstalledPlugin[];
}

export interface PluginStoreClient {
  list(refresh?: boolean): Promise<StoreEntry[]>;
  detail(id: string): Promise<StoreDetail>;
  install(id: string): Promise<StoreInstallRecord>;
  uninstall(id: string): Promise<void>;
  state(): Promise<StorePluginsState>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
}

export class StoreClientError extends Error {
  readonly command: string;
  constructor(command: string, message: string) {
    super(message);
    this.name = "StoreClientError";
    this.command = command;
  }
}

// The backend serializes AppError as a bare string such as "IO error: <detail>".
const BACKEND_PREFIX = /^(IO error|Invalid path|Not found|Already exists):\s*/i;

function messageOf(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw instanceof Error) return raw.message;
  if (raw && typeof raw === "object") {
    const m = (raw as { message?: unknown }).message;
    if (typeof m === "string") return m;
    try {
      return JSON.stringify(raw);
    } catch {
      /* fall through */
    }
  }
  return "";
}

/** Any thrown value -> StoreClientError with a short, user-presentable message. */
export function normalizeStoreError(command: string, raw: unknown): StoreClientError {
  if (raw instanceof StoreClientError) return raw;
  const text = messageOf(raw).replace(BACKEND_PREFIX, "").trim();
  return new StoreClientError(command, text || `${command} failed`);
}

export function errorMessage(e: unknown): string {
  return normalizeStoreError("plugin store", e).message;
}

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

export function createStoreClient(
  invoke: Invoke = (cmd, args) => hostInvoke(cmd, args),
): PluginStoreClient {
  const call = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    try {
      return (await invoke(cmd, args)) as T;
    } catch (e) {
      throw normalizeStoreError(cmd, e);
    }
  };
  return {
    list: (refresh) => call("plugin_store_list", { refresh: refresh ?? false }),
    detail: (id) => call("plugin_store_detail", { id }),
    install: (id) => call("plugin_store_install", { id }),
    uninstall: (id) => call("plugin_store_uninstall", { id }),
    state: () => call("plugins_state"),
    setEnabled: (id, enabled) => call("plugins_set_enabled", { id, enabled }),
  };
}

export const defaultStoreClient: PluginStoreClient = createStoreClient();
