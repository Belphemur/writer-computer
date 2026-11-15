import { create } from "zustand";

export type CommandPaletteIntent = "search" | "create-file" | "search-notes";

interface UIState {
  isCommandPaletteOpen: boolean;
  commandPaletteIntent: CommandPaletteIntent;
  commandPaletteSearch: string;
  isPluginBrowserOpen: boolean;

  openPluginBrowser: () => void;
  closePluginBrowser: () => void;
  openCommandPalette: (intent?: CommandPaletteIntent) => void;
  closeCommandPalette: () => void;
  setCommandPaletteSearch: (search: string) => void;
}

export const useUIStore = create<UIState>((set) => ({
  isCommandPaletteOpen: false,
  commandPaletteIntent: "search",
  commandPaletteSearch: "",
  isPluginBrowserOpen: false,

  openPluginBrowser: () => set({ isPluginBrowserOpen: true }),
  closePluginBrowser: () => set({ isPluginBrowserOpen: false }),
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
