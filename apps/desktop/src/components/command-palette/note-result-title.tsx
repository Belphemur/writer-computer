import { noteLabel } from "@/lib/note-title";

/**
 * The first line of a note result row in every palette (quick open, recents, "Search in notes"):
 * the frontmatter `title` override in italic with the tooltip "Title override. File: X.md", else
 * `name` (the file name). The path or folder goes on the secondary line by the caller.
 */
export function NoteResultTitle({
  path,
  name,
  override,
}: {
  path: string;
  name: string;
  override?: string | null;
}) {
  const label = noteLabel(path, override);
  return (
    <span
      className={`truncate ${label.isOverride ? "italic" : ""}`}
      title={label.tooltip}
      data-title-override={label.isOverride || undefined}
    >
      {label.isOverride ? label.text : name}
    </span>
  );
}
