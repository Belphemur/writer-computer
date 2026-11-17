// The agent pane's visibility and width: the only agent state the layout needs before the chat
// store exists. The dock contribution reads it, so the feature's startup path (and the entry
// chunk) holds this module and not the chat store, its reducer and the rest of `web/lib`; the chat
// store loads when the pane first opens (SPECs/builtin-plugins-spec.md, "Step 5: projects"). Persisted in the `agent.pane-open` / `agent.pane-width` settings, which are
// also edited in Settings: `syncOpen` / `syncWidth` adopt them without writing back.
import { create } from "zustand";
import { logger } from "@/lib/logger";
import { useSettingsStore } from "@/stores/settings-store";

export const AGENT_PANE_WIDTH_SETTING = "agent.pane-width";
export const AGENT_PANE_OPEN_SETTING = "agent.pane-open";
export const AGENT_PANE_MIN_WIDTH = 320;
/** The `agent.pane-width` setting's range (shared/settings.schema.json). */
export const AGENT_PANE_MAX_WIDTH = 900;
export const AGENT_PANE_DEFAULT_WIDTH = 420;

const clampWidth = (w: number) =>
  Math.max(AGENT_PANE_MIN_WIDTH, Math.min(AGENT_PANE_MAX_WIDTH, Math.round(w)));

interface PaneState {
  open: boolean;
  width: number;
  /** The one write path of `open`: sets it and saves it in `agent.pane-open` (a no-op when
   *  unchanged). Never starts the CLI. */
  setOpen: (open: boolean) => void;
  /** Adopts the `agent.pane-open` setting (startup, and when Settings changes it): state only,
   *  nothing is written back. */
  syncOpen: (value: unknown) => void;
  /** `persist: false` while dragging; call `persistWidth` when the drag ends. */
  setWidth: (width: number, persist?: boolean) => void;
  persistWidth: () => void;
  /** Adopts the `agent.pane-width` setting, clamped. */
  syncWidth: (value: unknown) => void;
}

export const usePaneStore = create<PaneState>((set, get) => ({
  open: false,
  width: AGENT_PANE_DEFAULT_WIDTH,
  setOpen: (open) => {
    if (get().open === open) return;
    set({ open });
    void useSettingsStore
      .getState()
      .setSetting(AGENT_PANE_OPEN_SETTING, open)
      .catch((e: unknown) => logger.warn("agent", `could not save the pane state: ${String(e)}`));
  },
  syncOpen: (value) => {
    if (typeof value !== "boolean" || value === get().open) return;
    set({ open: value });
  },
  setWidth: (width, persist = true) => {
    const next = clampWidth(width);
    if (next === get().width) return;
    set({ width: next });
    if (persist) get().persistWidth();
  },
  persistWidth: () => {
    void useSettingsStore
      .getState()
      .setSetting(AGENT_PANE_WIDTH_SETTING, get().width)
      .catch((e: unknown) => logger.warn("agent", `could not save the pane width: ${String(e)}`));
  },
  syncWidth: (value) => {
    if (typeof value === "number" && Number.isFinite(value) && clampWidth(value) !== get().width)
      set({ width: clampWidth(value) });
  },
}));
