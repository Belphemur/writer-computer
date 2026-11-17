import { useResolvedDocumentTitle } from "@/hooks/use-tabs";
import { noteLabel, type NoteLabel } from "@/lib/note-title";
import type { DirEntry } from "@/types/fs";

/**
 * The label for a file-tree entry: folders show their name; a note shows its file name without
 * the extension unless it sets a frontmatter `title` (an override, flagged on the returned label).
 * This is the key the tree sorts by, so ordering and labels never disagree. A heading is never a
 * label.
 */
export function fileTreeLabel(entry: DirEntry): NoteLabel {
  if (entry.is_dir) return { text: entry.name, isOverride: false, tooltip: undefined };
  return noteLabel(entry.path, entry.title);
}

/**
 * The label shown for a file-tree entry. Same as {@link fileTreeLabel}, except an open document's
 * live frontmatter title wins while it is being edited, so the row tracks the property as the
 * user types. Shared by the tree rows and the drag ghost so they always display the same text.
 */
export function useFileTreeLabel(entry: DirEntry): NoteLabel {
  const editorTitle = useResolvedDocumentTitle(entry.is_dir ? null : entry.path);
  if (entry.is_dir) return fileTreeLabel(entry);
  return noteLabel(entry.path, editorTitle || entry.title);
}
