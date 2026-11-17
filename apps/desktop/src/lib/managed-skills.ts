import { invoke } from "@tauri-apps/api/core";

/** Absolute paths of the Writer-managed skill folders of the open workspace (marker in SKILL.md). */
export function listManagedSkillDirs(): Promise<string[]> {
  return invoke("list_managed_skill_dirs");
}

/** The managed skill folder that holds `path`, given the folders `listManagedSkillDirs` returned. */
export function managedSkillDirFor(path: string, managedDirs: readonly string[]): string | null {
  const normalized = path.replace(/\\/g, "/");
  for (const dir of managedDirs) {
    const d = dir.replace(/\\/g, "/").replace(/\/$/, "");
    if (normalized === d || normalized.startsWith(d + "/")) return dir;
  }
  return null;
}
