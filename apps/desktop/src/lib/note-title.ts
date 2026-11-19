import { isDocumentName, isRenderableImageName } from "./attachments";
import { isCodePath } from "./code-files";
import { getFileName, getFileStem } from "./paths";

/**
 * A note's title is its file name without the extension. Only an explicit frontmatter `title`
 * property overrides it (SPECs/filename-links-and-rename-spec.md, "Display titles"); the first
 * heading never does. Every surface that labels a note goes through here.
 */
export interface NoteLabel {
  /** What to show: the override when set, else the file name without extension. */
  text: string;
  /** The label is a frontmatter `title`, not the file name: surfaces mark it. */
  isOverride: boolean;
  /** Tooltip naming the file behind an override; `undefined` when there is no override. */
  tooltip: string | undefined;
}

export function noteLabel(path: string, override?: string | null): NoteLabel {
  // A code file, an image or a PDF keeps its extension (`run.py`, `Dockerfile`, `shot.png`,
  // `paper.pdf`): it is part of what the file is.
  if (
    isCodePath(path) ||
    isRenderableImageName(getFileName(path)) ||
    isDocumentName(getFileName(path))
  )
    return { text: getFileName(path), isOverride: false, tooltip: undefined };
  const stem = getFileStem(path);
  const title = override?.trim();
  if (!title || title === stem) return { text: stem, isOverride: false, tooltip: undefined };
  return { text: title, isOverride: true, tooltip: `Title override. File: ${getFileName(path)}` };
}
