// Which embedded drawing is being edited in place (ADR 2026-11-18, "edit in place"): at most one
// at a time, named by its widget's host element (never a document position: two embeds of one
// drawing are two hosts, and a rebuilt widget has a new host and is a picture again). Opening a
// second one replaces the first, which is how the first closes.
import { create } from "zustand";

interface InlineEditorStore {
  host: HTMLElement | null;
  enter: (host: HTMLElement) => void;
  /** Leave edit mode, if `host` is the one being edited. */
  exit: (host: HTMLElement) => void;
}

export const useInlineEditor = create<InlineEditorStore>((set) => ({
  host: null,
  enter: (host) => set({ host }),
  exit: (host) => set((s) => (s.host === host ? { host: null } : s)),
}));
