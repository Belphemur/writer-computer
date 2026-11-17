import { useEffect } from "react";
import { loadAgentSkills } from "@/hooks/agent-api";

/** Reads the skills on disk when a chat's composer mounts (and when its project changes), so the
 *  Skills chip and the first `/` already have them. The `/` menu refreshes them again on open. */
export function useLoadSkillsOnMount(projectPath: string | null) {
  useEffect(() => {
    void loadAgentSkills(projectPath);
  }, [projectPath]);
}
