// The typed client of the icons commands (Rust half in `../rust/`, spec `SPECs/icons-spec.md`).
// The wire types come from the generated `bindings.ts`, so a field change in Rust is a type error
// here. Tests mock this module; nothing else reaches the backend.
import { featureInvoke } from "@/lib/features/ipc";
import manifest from "../feature.json";
import type * as wire from "./bindings";

export interface IconRow {
  path: string;
  /** `emoji:<emoji>` or `icon:<Hugeicons name>`. */
  icon: string;
  color?: string;
  source: "writer" | "iconize";
}

export interface IconsResolved {
  icons: IconRow[];
  /** Iconize icons from packs Writer does not show. */
  iconizeUnsupported: number;
}

interface IconsCommands {
  icons_resolved: { args: undefined; result: wire.IconsResolved };
  icons_set: {
    args: { paths: string[]; icon: string; color: string | null };
    result: null;
  };
  icons_remove: { args: { paths: string[] }; result: null };
}

const call = featureInvoke<IconsCommands>(manifest.id, manifest.rust.commands);

/** Every icon of the vault after resolution (Writer's file over Iconize's). */
export async function iconsResolved(): Promise<IconsResolved> {
  const r = await call("icons_resolved");
  return {
    iconizeUnsupported: r.iconizeUnsupported,
    icons: r.icons.map(({ path, icon, color, source }) => ({
      path,
      icon,
      ...(color ? { color } : {}),
      source: source === "iconize" ? "iconize" : "writer",
    })),
  };
}

export async function iconsSet(paths: string[], icon: string, color?: string): Promise<void> {
  await call("icons_set", { paths, icon, color: color ?? null });
}

export async function iconsRemove(paths: string[]): Promise<void> {
  await call("icons_remove", { paths });
}

/** The event the backend sends when `.writer/icons.json` or Iconize's data changed on disk. */
export const ICONS_CHANGED = "changed";
