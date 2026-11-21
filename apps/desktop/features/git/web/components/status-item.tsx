// The footer item: `Local`, `Pending n`, `Paused` or `Error` (hidden until the vault has history).
// A click opens the panel in the sidebar.
import { HugeiconsIcon } from "@hugeicons/react";
import { GitCommitIcon } from "@hugeicons/core-free-icons";
import { openSettings } from "@/hooks/editor-api";
import { useUIStore } from "@/stores/ui-store";
import { summarize } from "../lib/state";
import { useGitStatus } from "../lib/status-store";

export const PANEL_ID = "git.panel";

const TONE: Record<string, string> = {
  ok: "text-[var(--text-muted)]",
  quiet: "text-[var(--text-muted)]",
  pending: "text-[var(--accent)]",
  error: "text-[var(--danger,var(--accent))]",
};

export default function GitStatusItem() {
  const status = useGitStatus((s) => s.status);
  const summary = summarize(status);
  if (!summary) return null;
  return (
    <button
      type="button"
      data-git-status={summary.tone}
      title={summary.detail}
      onClick={() =>
        summary.setup ? openSettings("git") : useUIStore.getState().selectSidebarPanel(PANEL_ID)
      }
      className={`inline-flex items-center gap-1 rounded px-1.5 text-xs leading-5 hover:bg-[var(--surface-subtle)] focus-visible:outline-none focus-visible:bg-[var(--surface-subtle)] ${TONE[summary.tone]}`}
    >
      <HugeiconsIcon icon={GitCommitIcon} size={14} aria-hidden />
      {summary.label}
    </button>
  );
}
