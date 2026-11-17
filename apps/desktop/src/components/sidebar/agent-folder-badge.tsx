import { useManagedSkillDirs } from "@/hooks/use-managed-skill-dirs";
import { agentSkillDir, isAgentFolderPath } from "@/lib/code-files";
import { managedSkillDirFor } from "@/lib/managed-skills";
import { useWorkspaceRoot } from "@/hooks/use-workspace";
import type { DirEntry } from "@/types/fs";
import { AgentSkillsBadge, ManagedSkillBadge, SymlinkBadge } from "./file-tree-icons";

/**
 * The badges of a folder row: "Agent skills" on `.agents`, `.claude` and their `skills` folder,
 * "Managed by Writer, overwritten on update" on a skill folder Writer installed (marker in its
 * SKILL.md), and "symlink to <folder>" on a folder that is a link inside the vault. Renders
 * nothing for any other folder.
 */
export function AgentFolderBadge({ entry }: { entry: DirEntry }) {
  const root = useWorkspaceRoot();
  const isSkillFolder = agentSkillDir(entry.path, root) === entry.path.replace(/\\/g, "/");
  const managedDirs = useManagedSkillDirs(isSkillFolder);
  const kind = isAgentFolderPath(entry.path, root)
    ? "agent"
    : isSkillFolder && managedSkillDirFor(entry.path, managedDirs)
      ? "managed"
      : null;
  const link = entry.symlink_target;
  return (
    <>
      {kind === "agent" ? <AgentSkillsBadge /> : kind === "managed" ? <ManagedSkillBadge /> : null}
      {link ? <SymlinkBadge target={link} withSibling={kind !== null} /> : null}
    </>
  );
}
