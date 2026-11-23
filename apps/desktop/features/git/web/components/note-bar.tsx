// The one-line bar over an open note a sync could not merge (slot `note-bar`, spec
// `SPECs/git-sync-spec.md` "Merge view"): "Changed on another device — Resolve". It never opens the
// merge view by itself, and never touches the buffer: autosave keeps writing the user's text
// locally (the conflicted file is never committed), so nothing typed is lost.
import { relativeInVault } from "@/lib/paths";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useGitStatus } from "../lib/status-store";
import { openMerge } from "../lib/resolve-conflicts";

export default function GitNoteBar({ path }: { path: string }) {
  const root = useWorkspaceStore((s) => s.root);
  const rel = root ? relativeInVault(path, root) : null;
  const conflicted = useGitStatus((s) => s.status?.conflicts.some((c) => c.path === rel) ?? false);
  if (!rel || !conflicted) return null;
  return (
    <div
      role="status"
      data-git-note-bar
      className="absolute inset-x-3 top-3 z-20 flex items-center gap-3 rounded-lg px-3 py-1.5 text-[12px]"
      style={{
        background: "var(--surface-card)",
        border: "1px solid var(--line-subtler)",
        color: "var(--text-secondary)",
      }}
    >
      <span className="min-w-0 flex-1 truncate">Changed on another device —</span>
      <button
        type="button"
        data-git-note-bar-resolve
        className="shrink-0 cursor-pointer border-0 bg-transparent text-[12px] text-[var(--text-primary)] underline"
        onClick={() => openMerge(rel)}
      >
        Resolve
      </button>
    </div>
  );
}
