/**
 * Pure helpers for the project dialog and home: source chips (how a picked folder, note or tag is
 * written into `copilot-project-inclusions`), name checks mirroring `agent/project.rs`
 * (`sanitize_name`), and the paths a dialog previews. The Rust side stays the authority.
 */
import { getParentDir, getRelativePath } from "@/lib/paths";
import type { MentionCandidate } from "./mentions";

export const DEFAULT_PROJECT_PARENT = "Projects";

export type SourceChip = {
  /** The exact entry stored in `project.md` (no commas). */
  raw: string;
  kind: "folder" | "note" | "tag";
  label: string;
};

export function chipFromCandidate(c: MentionCandidate): SourceChip {
  return c.kind === "folder"
    ? { raw: `${c.path.replace(/\/+$/, "")}/`, kind: "folder", label: `${c.path}/` }
    : { raw: c.path, kind: "note", label: c.path };
}

/** `#tag` or `tag` typed by the user; null when it is not a usable tag. */
export function chipFromTag(input: string): SourceChip | null {
  const tag = input.trim().replace(/^#+/, "");
  if (!tag || /[\s,]/.test(tag)) return null;
  return { raw: `#${tag}`, kind: "tag", label: `#${tag}` };
}

export function addChip(chips: readonly SourceChip[], chip: SourceChip): SourceChip[] {
  return chips.some((c) => c.raw === chip.raw) ? [...chips] : [...chips, chip];
}

export type NameCheck = { ok: true; name: string } | { ok: false; reason: string };

/** Same rules as `project::sanitize_name`: separators are refused, illegal characters become `-`. */
export function checkProjectName(input: string): NameCheck {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, reason: "The project needs a name." };
  if (/[/\\]/.test(trimmed))
    return { ok: false, reason: "A name cannot contain / or \\. Use Location to pick a folder." };
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (/[\u0000-\u001f\u007f]/.test(trimmed))
    return { ok: false, reason: "A name cannot contain control characters." };
  const name = trimmed
    .replace(/[:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 100)
    .trim()
    .replace(/\.+$/, "")
    .trim();
  if (!name || name.startsWith("."))
    return { ok: false, reason: "A name cannot be empty or start with a dot." };
  return { ok: true, name };
}

/** Vault-relative parent: empty input means the default; slashes at the ends are dropped. */
export function normalizeParent(input: string): string {
  const p = input.trim().replace(/^\/+|\/+$/g, "");
  return p === "" ? DEFAULT_PROJECT_PARENT : p;
}

export function projectFolderPath(parent: string, name: string): string {
  return `${normalizeParent(parent)}/${name}`;
}

/** Why a location cannot be used, or null. Mirrors the confinement rules in Rust. */
export function checkParent(input: string): string | null {
  const p = normalizeParent(input);
  const segs = p.split("/");
  if (segs.some((s) => s === ".." || s === "." || s === ""))
    return "Location must stay inside the vault.";
  if (segs.some((s) => s.startsWith("."))) return "Hidden folders cannot hold projects.";
  return null;
}

/** Row label for a manifest entry kind. */
export function sourceKindLabel(kind: string): string {
  switch (kind) {
    case "folder":
      return "Folder";
    case "note":
      return "Note";
    case "tag":
      return "Tag";
    case "property":
      return "Property";
    case "url":
      return "Link";
    default:
      return kind;
  }
}

/** The folder that holds the active file, relative to the vault; null at the vault root. */
export function folderOfFile(filePath: string | null, root: string | null): string | null {
  if (!filePath || !root) return null;
  const rel = getRelativePath(getParentDir(filePath), root);
  if (!rel || rel === "/" || rel.startsWith("/")) return null;
  return rel;
}
