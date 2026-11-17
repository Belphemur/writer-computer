import { useManagedSkillDirs } from "@/hooks/use-managed-skill-dirs";
import { agentSkillDir, isAgentFolderPath } from "@/lib/code-files";
import { managedSkillDirFor } from "@/lib/managed-skills";
import { useWorkspaceRoot } from "@/hooks/use-workspace";
import type { DirEntry } from "@/types/fs";
import { AgentSkillsBadge, ManagedSkillBadge } from "./file-tree-icons";

/**
 * The badge of a folder row in the agent skills tree: "Agent skills" on `.agents`, `.claude` and
 * their `skills` folder, and "Managed by Writer, overwritten on update" on a skill folder Writer
 * installed (marker in its SKILL.md). Renders nothing for any other folder.
 */
export function AgentFolderBadge({ entry }: { entry: DirEntry }) {
  const root = useWorkspaceRoot();
  const isSkillFolder = agentSkillDir(entry.path, root) === entry.path.replace(/\\/g, "/");
  const managedDirs = useManagedSkillDirs(isSkillFolder);
  if (isAgentFolderPath(entry.path, root)) return <AgentSkillsBadge />;
  if (isSkillFolder && managedSkillDirFor(entry.path, managedDirs)) return <ManagedSkillBadge />;
  return null;
}
