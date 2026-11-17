// Open state of the plugin browser dialog (was `isPluginBrowserOpen` in the core ui-store): the
// dialog is the feature's overlay, so its state is the feature's too. Entry points are the
// Settings footer and the palette command.
import { create } from "zustand";

interface PluginBrowserState {
  isOpen: boolean;
  open: () => void;
  close: () => void;
}

export const usePluginBrowserStore = create<PluginBrowserState>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
}));
