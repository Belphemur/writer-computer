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
  /** The kind chip selected in the palettes (a `search_kinds` id), `null` for All. */
  commandPaletteKind: string | null;
  /** Selected Settings section id (see settings-sections.ts); remembered across restarts. */
  settingsSection: string;
  /** Selected left sidebar panel id: `files` (core) or a feature's panel; not remembered. */
  sidebarPanel: string;

  selectSidebarPanel: (id: string) => void;
  selectSettingsSection: (id: string) => void;
  hydrateSettingsSection: () => Promise<void>;
  /** `search` seeds the input (a query the caller already knows, such as `tag:draft `). */
  openCommandPalette: (intent?: CommandPaletteIntent, search?: string) => void;
  closeCommandPalette: () => void;
  setCommandPaletteSearch: (search: string) => void;
  setCommandPaletteKind: (kind: string | null) => void;
}

export const useUIStore = create<UIState>((set, get) => ({
  isCommandPaletteOpen: false,
  commandPaletteIntent: "search",
  commandPaletteSearch: "",
  commandPaletteKind: null,
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
  openCommandPalette: (intent = "search", search = "") =>
    set({
      isCommandPaletteOpen: true,
      commandPaletteIntent: intent,
      commandPaletteSearch: search,
      commandPaletteKind: null,
    }),
  closeCommandPalette: () =>
    set({
      isCommandPaletteOpen: false,
      commandPaletteIntent: "search",
      commandPaletteSearch: "",
      commandPaletteKind: null,
    }),
  setCommandPaletteSearch: (search: string) => set({ commandPaletteSearch: search }),
  setCommandPaletteKind: (kind: string | null) => set({ commandPaletteKind: kind }),
}));
