// Which files and folders the icon picker is open for (the overlay renders from it). Absolute
// paths, as the sidebar and the tabs hold them; Rust confines them to the vault.
import { create } from "zustand";

interface PickerState {
  paths: readonly string[] | null;
  open: (paths: readonly string[]) => void;
  close: () => void;
}

export const useIconPickerStore = create<PickerState>((set) => ({
  paths: null,
  open: (paths) => set({ paths: paths.length > 0 ? [...paths] : null }),
  close: () => set({ paths: null }),
}));

export const openIconPicker = (paths: readonly string[]) =>
  useIconPickerStore.getState().open(paths);
