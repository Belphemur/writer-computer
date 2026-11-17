// The synthetic memory folders the Settings > Agent tests answer `agent_memory_list` with (the
// section loads them when the page opens, so every test that mounts the page needs an answer).
import type { MemoryFile, MemoryOverview } from "../web/bindings";

export const MEMORY_VAULT_DIR = "/synthetic-vault/.writer/memory";
export const MEMORY_PROJECT_DIR = "/synthetic-vault/Projects/P/.memory";

const file = (name: string, dir: string): MemoryFile => ({
  name,
  path: `${dir}/${name}`,
  bytes: 120,
  modifiedMs: 1,
});

export function memoryOverview(
  opts: { project?: boolean; vaultFiles?: string[] } = {},
): MemoryOverview {
  const vaultFiles = opts.vaultFiles ?? ["MEMORY.md", "user-cat.md"];
  return {
    vault: {
      scope: "vault",
      path: MEMORY_VAULT_DIR,
      exists: vaultFiles.length > 0,
      files: vaultFiles.map((n) => file(n, MEMORY_VAULT_DIR)),
    },
    project: opts.project
      ? {
          scope: "project",
          path: MEMORY_PROJECT_DIR,
          exists: true,
          files: [file("MEMORY.md", MEMORY_PROJECT_DIR)],
        }
      : null,
  };
}
