import { IconGlyph } from "@/components/icon-picker/icon-glyph";
import { useFileIcon } from "@/lib/file-icons";
import { openIconPicker } from "./picker-store";

/**
 * The note's icon above its properties, small; a click opens the picker. Nothing (and no reserved
 * space) while the note has none: the icon is set from "Change icon..." in the context menus and
 * the palette. The slot `editor-note-header` hands the note's absolute path.
 */
export default function NoteIcon({ path }: { path: string }) {
  const icon = useFileIcon(path);
  if (!icon) return null;
  return (
    <button
      type="button"
      data-note-icon
      aria-label="Change icon"
      title="Change icon"
      onClick={() => openIconPicker([path])}
      className="mb-1 flex size-8 items-center justify-center rounded-md hover:bg-[var(--surface-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-border)]"
    >
      <IconGlyph value={icon.icon} color={icon.color} size={22} />
    </button>
  );
}
