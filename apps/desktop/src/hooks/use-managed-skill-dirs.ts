import { useEffect, useState } from "react";
import { listManagedSkillDirs } from "@/lib/managed-skills";
import { useWorkspaceRoot } from "@/hooks/use-workspace";

const cache = new Map<string, Promise<string[]>>();

/** Forget the cached folder list of `root` (after a skills sync, or in tests). */
export function invalidateManagedSkillDirs(root?: string) {
  if (root) cache.delete(root);
  else cache.clear();
}

/** The Writer-managed skill folders of the open workspace (absolute paths), fetched once per workspace. */
export function useManagedSkillDirs(enabled = true): readonly string[] {
  const root = useWorkspaceRoot();
  const [dirs, setDirs] = useState<readonly string[]>([]);
  useEffect(() => {
    if (!enabled || !root) return;
    let live = true;
    let pending = cache.get(root);
    if (!pending) {
      pending = listManagedSkillDirs().catch(() => []);
      cache.set(root, pending);
    }
    void pending.then((list) => {
      if (live) setDirs(list);
    });
    return () => {
      live = false;
    };
  }, [enabled, root]);
  return dirs;
}
