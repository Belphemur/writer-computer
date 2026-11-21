import { useSettingsStore } from "@/stores/settings-store";
import type { OpenFile } from "@/hooks/editor-api";
import { serializeDocument } from "@/lib/frontmatter";
import { runBeforeSave } from "@/lib/features/before-save";
import * as tauri from "@/lib/tauri";

const THROTTLE_MS = 1000;

/**
 * The slice of editor-store behavior the save engine needs. The store injects
 * it via `registerSaveStore` at startup so this `lib/` module never imports
 * `stores/editor-store` — that back-edge would invert the stores → lib layering
 * and form an import cycle (the store already imports the save engine).
 */
export interface SaveStoreAccess {
  getOpenFile: (path: string) => OpenFile | undefined;
  markSaved: (path: string, diskContent: string, hasNewerChanges: boolean) => void;
  setSaveError: (path: string, error: string) => void;
}

let storeAccess: SaveStoreAccess | null = null;

/** Wire the save engine to the editor store. Called once from editor-store at
 *  module init. */
export function registerSaveStore(access: SaveStoreAccess) {
  storeAccess = access;
}

function requireStore(): SaveStoreAccess {
  if (!storeAccess) {
    throw new Error("[save] used before registerSaveStore() — editor store not wired");
  }
  return storeAccess;
}

interface SaveController {
  lastSaveTime: number;
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: boolean;
  pending: boolean;
  /** The save that is in flight, for `flushSave` to wait on. */
  running: Promise<void> | null;
}

const saveControllers = new Map<string, SaveController>();

function getSaveController(path: string): SaveController {
  let controller = saveControllers.get(path);
  if (!controller) {
    controller = {
      lastSaveTime: 0,
      timer: null,
      inFlight: false,
      pending: false,
      running: null,
    };
    saveControllers.set(path, controller);
  }
  return controller;
}

function clearSaveTimer(controller: SaveController) {
  if (!controller.timer) return;
  clearTimeout(controller.timer);
  controller.timer = null;
}

function cleanupSaveController(path: string, controller: SaveController) {
  if (controller.inFlight || controller.pending || controller.timer) return;
  saveControllers.delete(path);
}

export function scheduleSave(path: string) {
  const controller = getSaveController(path);
  controller.pending = true;
  queueSave(path, controller);
}

export function isSaveInFlight(path: string) {
  return saveControllers.get(path)?.inFlight === true;
}

/**
 * Writes the open note's unsaved edits now, through the normal save (throttle skipped, features'
 * before-save work included), waiting for a save already in flight. For a caller about to change
 * the file on disk under the editor (a restore from history): its buffer must be on disk first,
 * so it is in the history and not lost. Throws when the save fails.
 */
export async function flushSave(path: string): Promise<void> {
  const store = requireStore();
  for (;;) {
    const controller = saveControllers.get(path);
    if (controller?.inFlight) {
      await controller.running;
    } else {
      if (!store.getOpenFile(path)?.isDirty) return;
      if (controller) clearSaveTimer(controller);
      await performSave(path);
    }
    const file = store.getOpenFile(path);
    if (file?.saveError) throw new Error(file.saveError);
    if (!file?.isDirty) return;
  }
}

export function cancelSave(path: string) {
  const controller = saveControllers.get(path);
  if (!controller) return;

  controller.pending = false;
  clearSaveTimer(controller);
  cleanupSaveController(path, controller);
}

function queueSave(path: string, controller: SaveController) {
  if (controller.inFlight) return;

  clearSaveTimer(controller);

  const elapsed = Date.now() - controller.lastSaveTime;
  if (elapsed >= THROTTLE_MS) {
    void performSave(path, controller);
    return;
  }

  controller.timer = setTimeout(() => {
    controller.timer = null;
    void performSave(path, controller);
  }, THROTTLE_MS - elapsed);
}

function applyFileProcessing(content: string): string {
  const settings = useSettingsStore.getState().settings;
  let result = content;

  if (settings["files.trim-trailing-whitespace"]) {
    result = result
      .split("\n")
      .map((line) => line.replace(/\s+$/, ""))
      .join("\n");
  }

  if (settings["files.insert-final-newline"]) {
    if (!result.endsWith("\n")) {
      result += "\n";
    }
  }

  return result;
}

function serializeForSave(file: OpenFile) {
  return applyFileProcessing(serializeDocument(file.frontmatter, file.content));
}

function performSave(path: string, controller = getSaveController(path)): Promise<void> {
  if (controller.inFlight) return controller.running ?? Promise.resolve();
  const run = doSave(path, controller);
  controller.running = run;
  return run;
}

async function doSave(path: string, controller: SaveController) {
  const store = requireStore();
  const file = store.getOpenFile(path);
  if (!file || !file.isDirty) {
    controller.pending = false;
    cleanupSaveController(path, controller);
    return;
  }

  controller.inFlight = true;
  controller.pending = false;
  controller.lastSaveTime = Date.now();

  let shouldReschedule = false;

  try {
    // Features may edit the note first (lint's fix on save): the editor sync puts the edit in the
    // store, and what is serialized below is read after it. The edit asks for a save of its own
    // (`pending`); this write carries it, so that request is spent.
    const before = runBeforeSave(path);
    if (before) {
      await before;
      controller.pending = false;
    }
    const current = store.getOpenFile(path);
    if (!current) return;
    const full = serializeForSave(current);

    await tauri.writeFile(path, full);

    const latestFile = store.getOpenFile(path);
    if (!latestFile) return;

    shouldReschedule = serializeForSave(latestFile) !== full;
    store.markSaved(path, full, shouldReschedule);
  } catch (err) {
    console.error(`[save] Failed to save ${path}:`, err);
    const message = err instanceof Error ? err.message : String(err);
    store.setSaveError(path, message);
  } finally {
    controller.inFlight = false;

    const needsFollowUpSave = controller.pending || shouldReschedule;
    if (needsFollowUpSave) {
      queueSave(path, controller);
    } else {
      cleanupSaveController(path, controller);
    }
  }
}
