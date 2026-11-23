// What Settings > Git's sections share: the layout classes, the setting keys and the schema lookup.
import { FEATURE_SETTINGS, type SettingDef } from "@/lib/settings-schema";

export const CARD =
  "overflow-hidden rounded-2xl border border-[var(--line-subtler)] bg-[var(--surface-card)]";
export const ROW = "flex items-center justify-between gap-4 px-4 py-3 text-[13px]";
export const MUTED = "text-[var(--text-muted)]";
export const KEYS = {
  commitAfter: "git.commit-after",
  agentCommits: "git.agent-commits",
  commitMessage: "git.commit-message",
  syncInterval: "git.sync-interval",
  lfs: "git.lfs",
  lfsThreshold: "git.lfs-threshold-mb",
} as const;

export function defsFor(...keys: string[]): SettingDef[] {
  return ((FEATURE_SETTINGS.git ?? []) as readonly SettingDef[]).filter((d) =>
    keys.includes(d.key),
  );
}
