import { create } from "zustand";
import { DEFAULT_SETTINGS_SECTION } from "@/components/settings-panel/settings-sections";
import { getPreference, setPreference } from "@/lib/preferences";

/** The core Files panel of the left sidebar. */
export const FILES_PANEL_ID = "files";

export const SETTINGS_SECTION_PREFERENCE = "settings.section";

export type CommandPaletteIntent = "search" | "create-file" | "search-notes";

interface UIState {
  isCommandPaletteOpen: boolean;
  commandPaletteIntent: CommandPaletteIntent;
  commandPaletteSearch: string;
  /** Selected Settings section id (see settings-sections.ts); remembered across restarts. */
  settingsSection: string;
  /** Selected left sidebar panel id: `files` (core) or a feature's panel; not remembered. */
  sidebarPanel: string;

  selectSidebarPanel: (id: string) => void;
  selectSettingsSection: (id: string) => void;
  hydrateSettingsSection: () => Promise<void>;
  openCommandPalette: (intent?: CommandPaletteIntent) => void;
  closeCommandPalette: () => void;
  setCommandPaletteSearch: (search: string) => void;
}

export const useUIStore = create<UIState>((set, get) => ({
  isCommandPaletteOpen: false,
  commandPaletteIntent: "search",
  commandPaletteSearch: "",
  settingsSection: DEFAULT_SETTINGS_SECTION,
  sidebarPanel: FILES_PANEL_ID,

  selectSidebarPanel: (id) => set({ sidebarPanel: id }),
  selectSettingsSection: (id) => {
    if (get().settingsSection === id) return;
    set({ settingsSection: id });
    void setPreference(SETTINGS_SECTION_PREFERENCE, id);
  },
  hydrateSettingsSection: async () => {
    const stored = await getPreference<unknown>(SETTINGS_SECTION_PREFERENCE, null);
    // A selection made while the read was in flight wins over the stored one.
    if (typeof stored === "string" && stored && get().settingsSection === DEFAULT_SETTINGS_SECTION)
      set({ settingsSection: stored });
  },
  openCommandPalette: (intent = "search") =>
    set({ isCommandPaletteOpen: true, commandPaletteIntent: intent, commandPaletteSearch: "" }),
  closeCommandPalette: () =>
    set({
      isCommandPaletteOpen: false,
      commandPaletteIntent: "search",
      commandPaletteSearch: "",
    }),
  setCommandPaletteSearch: (search: string) => set({ commandPaletteSearch: search }),
}));
