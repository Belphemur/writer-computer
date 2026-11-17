import { create } from "zustand";

/** The note whose display-title dialog is open (`null`: closed). One dialog for the palette, the
 *  tab menu and the sidebar menu. `clear` opens it with the title emptied, ready to confirm. */
interface NoteTitleDialogState {
  path: string | null;
  clear: boolean;
}

export const useNoteTitleDialogStore = create<NoteTitleDialogState>(() => ({
  path: null,
  clear: false,
}));

export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}

export function openNoteTitleDialog(path: string, options: { clear?: boolean } = {}): void {
  if (isMarkdownPath(path)) {
    useNoteTitleDialogStore.setState({ path, clear: options.clear === true });
  }
}

export function closeNoteTitleDialog(): void {
  useNoteTitleDialogStore.setState({ path: null, clear: false });
}
