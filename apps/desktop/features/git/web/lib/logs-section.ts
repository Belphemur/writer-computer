// Whether Settings > Git's "Logs" section is open, and the request to show its latest error.
// "Show logs" next to any error opens the section (`show`); the section mounts the log view only
// while it is open, so a collapsed section has no feed.
import { create } from "zustand";

interface LogsSection {
  open: boolean;
  /** Bumped by every `show`: the view scrolls to the latest error when it changes. */
  reveal: number;
  setOpen: (open: boolean) => void;
  show: () => void;
}

export const useLogsSection = create<LogsSection>((set) => ({
  open: false,
  reveal: 0,
  // closing forgets the request: opening it by hand later must not scroll to an old error
  setOpen: (open) => set(open ? { open } : { open: false, reveal: 0 }),
  show: () => set((s) => ({ open: true, reveal: s.reveal + 1 })),
}));
