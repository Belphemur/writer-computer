import { invoke } from "@tauri-apps/api/core";
import * as editorApi from "@/hooks/editor-api";
import {
  hasUnsavedEditorChanges,
  reloadOpenNoteAfterWrite,
} from "@/components/base-view/open-note-sync";
import { inferTitle, parseFrontmatter } from "@/lib/frontmatter";
import * as tauri from "@/lib/tauri";

/** Mirrors `commands/fs.rs::RetitleResult`. */
export interface RetitleResult {
  old: string | null;
  new: string | null;
  links: number;
  files: number;
  linksUpdated: boolean;
  changed: boolean;
}

/**
 * Set (`title`) or clear (`null`) the display title of a note: the frontmatter `title` property,
 * written by `relocate::retitle` (the same plan/apply as `writer title`). With `updateLinks`,
 * `[[File|Old title]]` aliases in the vault follow. `dryRun` writes nothing and reports the counts.
 */
export function retitleNote(
  path: string,
  title: string | null,
  options: { updateLinks: boolean; dryRun: boolean },
): Promise<RetitleResult> {
  return invoke("retitle_note", {
    path,
    title,
    updateLinks: options.updateLinks,
    dryRun: options.dryRun,
  });
}

/** The note's current display-title override (`null`: it shows its file name). */
export async function readNoteTitleOverride(path: string): Promise<string | null> {
  const open = editorApi.getOpenFile(path);
  if (open && !open.isLoading) return open.title || null;
  const file = await tauri.readFile(path);
  return inferTitle(parseFrontmatter(file.content).frontmatter).title || null;
}

export const UNSAVED_TITLE_MESSAGE =
  "This note has unsaved changes. Wait for it to save, then set the title.";

/** Apply a title change, then refresh an open editor and the links' open tabs. Throws a readable
 *  message when the note has unsaved edits (the write would be overwritten by the next save). */
export async function applyNoteTitle(
  path: string,
  title: string | null,
  updateLinks: boolean,
): Promise<RetitleResult> {
  if (hasUnsavedEditorChanges(path)) throw new Error(UNSAVED_TITLE_MESSAGE);
  const result = await retitleNote(path, title, { updateLinks, dryRun: false });
  await reloadOpenNoteAfterWrite(path);
  return result;
}
