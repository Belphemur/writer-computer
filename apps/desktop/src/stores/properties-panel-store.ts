import { create } from "zustand";

// Session-only, per-note state of the properties panel. A path with no entry follows the global
// default (`editor.properties-default-collapsed`) and the size heuristic; an entry means the user
// toggled that note. Not persisted: the choice lasts until the app quits.
interface NotePanelState {
  collapsed?: boolean;
  source?: boolean;
}

interface PropertiesPanelStore {
  notes: Map<string, NotePanelState>;
  setCollapsed: (path: string, collapsed: boolean) => void;
  setSource: (path: string, source: boolean) => void;
}

function patch(state: PropertiesPanelStore, path: string, next: NotePanelState) {
  const notes = new Map(state.notes);
  notes.set(path, { ...state.notes.get(path), ...next });
  return { notes };
}

export const usePropertiesPanelStore = create<PropertiesPanelStore>((set) => ({
  notes: new Map(),
  setCollapsed: (path, collapsed) => set((s) => patch(s, path, { collapsed })),
  setSource: (path, source) => set((s) => patch(s, path, { source })),
}));
