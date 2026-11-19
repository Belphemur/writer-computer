// One drawing session per file, shared by everything that shows the drawing: its tab and the
// inline editors of the notes that embed it (ADR 2026-11-18, "edit in place"). The first canvas
// to ask opens the session; the last to let go flushes and closes it. So a tab and an inline
// canvas on one drawing show one scene, share one save path and one watcher subscription (the
// disk store's `track`), and a change from outside (the CLI, sync) reloads both.
import { showEditorNotice } from "@/components/editor-area/editor-notice-store";
import { logger } from "@/lib/logger";
import * as tauri from "@/lib/tauri";
import { useDiskStore } from "../disk-sync";
import { prefersReducedMotion } from "./draw-in";
import { loadDrawingText, saveDrawing, type Loaded } from "./drawing-file";
import { loadExcalidraw, type ExcalidrawLib } from "./excalidraw-lib";
import { scheduleAutoExport } from "./export-svg";
import { registerLiveView } from "./live-views";
import { DrawingSession } from "./session";

export interface AcquiredSession {
  lib: ExcalidrawLib;
  session: DrawingSession;
  /** What the file held when the session opened. */
  loaded: Loaded;
  /** Let go; the last holder closes the session. Calling it again does nothing. */
  release: () => void;
}

interface Shared {
  lib: ExcalidrawLib;
  session: DrawingSession;
  loaded: Loaded;
  close: () => Promise<void>;
}

interface Entry {
  refs: number;
  shared: Promise<Shared>;
}

const entries = new Map<string, Entry>();
// A session being closed is still writing: the next one for the path waits for it.
const closing = new Map<string, Promise<void>>();

async function open(path: string): Promise<Shared> {
  await closing.get(path);
  const lib = await loadExcalidraw();
  const session = new DrawingSession(path, {
    read: async () => (await tauri.readFile(path)).content,
    load: (text) => loadDrawingText(path, text),
    save: (baseline, snapshot) => saveDrawing(path, baseline, snapshot),
    neverCapture: lib.CaptureUpdateAction.NEVER,
    reducedMotion: prefersReducedMotion,
    onSaved: () => {
      useDiskStore.getState().noteSaved(path);
      scheduleAutoExport(path);
    },
    onProblem: (message) => {
      logger.warn("excalidraw", message);
      showEditorNotice(message);
    },
  });
  const loaded = await session.open();
  const disk = useDiskStore.getState();
  disk.track(path);
  // A change from outside: merge it into the canvases.
  const unsubscribe = useDiskStore.subscribe((s, prev) => {
    if (s.views[path]?.version !== prev.views[path]?.version) void session.reload();
  });
  const unregister = registerLiveView(path, { flush: () => session.flush() });
  return {
    lib,
    session,
    loaded,
    close: async () => {
      unsubscribe();
      unregister();
      try {
        await session.flush();
      } finally {
        session.dispose();
        useDiskStore.getState().forget(path);
      }
    },
  };
}

function closeLater(path: string, shared: Promise<Shared>): void {
  const done = shared
    .then((s) => s.close())
    .catch(() => undefined) // never opened, or the save already reported its problem
    .finally(() => {
      if (closing.get(path) === done) closing.delete(path);
    });
  closing.set(path, done);
}

/** The session of the drawing at `path`, opened if nobody holds it yet. */
export async function acquireDrawingSession(path: string): Promise<AcquiredSession> {
  let entry = entries.get(path);
  if (!entry) {
    entry = { refs: 0, shared: open(path) };
    entries.set(path, entry);
    // a failed open leaves no entry, so the next try starts over
    entry.shared.catch(() => {
      if (entries.get(path) === entry) entries.delete(path);
    });
  }
  const held = entry;
  held.refs += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    held.refs -= 1;
    if (held.refs === 0 && entries.get(path) === held) {
      entries.delete(path);
      closeLater(path, held.shared);
    }
  };
  try {
    const { lib, session, loaded } = await held.shared;
    return { lib, session, loaded, release };
  } catch (e) {
    release();
    throw e;
  }
}
