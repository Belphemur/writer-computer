// The saved view config (filters, color rules, Group by, Display) of the graph tab, per vault in
// `.writer/graph.json`. One store, one write path: every change goes through `update`, which
// replaces the state and schedules a single debounced save. Loading and saving go through an
// injectable port (the default is `ipc.ts`), so a failure is reported once and the view keeps
// working from what is in memory.
import { create } from "zustand";
import { logger } from "@/lib/logger";
import {
  DEFAULT_CONFIG,
  parseConfig,
  serializeConfig,
  type GraphConfig,
  type SurfaceConfig,
} from "./config";
import { graphConfigRead, graphConfigWrite } from "./ipc";

export interface ConfigPort {
  read(): Promise<string | null>;
  write(content: string): Promise<void>;
}

const ipcPort: ConfigPort = { read: graphConfigRead, write: graphConfigWrite };
let port: ConfigPort = ipcPort;
export const SAVE_DEBOUNCE_MS = 400;

/** Tests swap the port; production never calls this. */
export function setConfigPort(next: ConfigPort | null) {
  port = next ?? ipcPort;
}

interface ConfigState {
  config: GraphConfig;
  loaded: boolean;
  /** Why the file could not be read or saved (shown as a quiet note), or null. */
  error: string | null;
  load: () => Promise<void>;
  update: (change: (s: SurfaceConfig) => SurfaceConfig) => void;
  reset: () => void;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let reported = false;
let loading: Promise<void> | null = null;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function report(what: string, e: unknown) {
  if (reported) return;
  reported = true;
  logger.warn("app", `graph config ${what} failed: ${message(e)}`);
}

export const useGraphConfig = create<ConfigState>()((set, get) => ({
  config: DEFAULT_CONFIG,
  loaded: false,
  error: null,
  load: () => {
    if (get().loaded) return Promise.resolve();
    loading ??= port
      .read()
      .then((text) => set({ config: parseConfig(text), loaded: true, error: null }))
      .catch((e: unknown) => {
        report("read", e);
        set({ loaded: true, error: message(e) });
      })
      .finally(() => {
        loading = null;
      });
    return loading;
  },
  update: (change) => {
    set((s) => ({ config: { ...s.config, global: change(s.config.global) } }));
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      port.write(serializeConfig(get().config)).catch((e: unknown) => {
        report("write", e);
        set({ error: message(e) });
      });
    }, SAVE_DEBOUNCE_MS);
  },
  reset: () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    loading = null;
    reported = false;
    set({ config: DEFAULT_CONFIG, loaded: false, error: null });
  },
}));
