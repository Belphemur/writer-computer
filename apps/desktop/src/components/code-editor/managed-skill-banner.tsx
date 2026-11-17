import { useState } from "react";
import { useManagedSkillDirs } from "@/hooks/use-managed-skill-dirs";
import { agentSkillDir } from "@/lib/code-files";
import { managedSkillDirFor } from "@/lib/managed-skills";
import { useWorkspaceRoot } from "@/hooks/use-workspace";

/** Skill folders whose warning the user dismissed this session (the warning shows once per folder). */
const dismissed = new Set<string>();

export const MANAGED_SKILL_WARNING =
  "Managed by Writer: edits to this skill are overwritten when Writer syncs its skills (when a workspace opens or the app updates). To customise it, copy the folder under another name and delete the writer-managed line in SKILL.md.";

/**
 * A one-time warning above a file inside a Writer-managed skill folder (`writer-cli`,
 * `writer-search`, `writer-bases`, identified by the marker in SKILL.md). Editing stays allowed.
 */
export function ManagedSkillBanner({ path }: { path: string }) {
  const root = useWorkspaceRoot();
  const inSkills = agentSkillDir(path, root) !== null;
  const dirs = useManagedSkillDirs(inSkills);
  const [, setVersion] = useState(0);
  const managed = inSkills ? managedSkillDirFor(path, dirs) : null;
  if (!managed || dismissed.has(managed)) return null;
  return (
    <div
      role="status"
      data-testid="managed-skill-banner"
      className="absolute inset-x-3 top-3 z-20 flex items-start gap-3 rounded-lg px-3 py-2 text-[12px]"
      style={{
        background: "var(--surface-card)",
        border: "1px solid var(--line-subtler)",
        color: "var(--text-secondary)",
      }}
    >
      <span className="min-w-0 flex-1">{MANAGED_SKILL_WARNING}</span>
      <button
        type="button"
        className="shrink-0 cursor-pointer border-0 bg-transparent text-[12px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
        onClick={() => {
          dismissed.add(managed);
          setVersion((v) => v + 1);
        }}
      >
        Dismiss
      </button>
    </div>
  );
}
