// The one-line bar over an open note a sync could not merge (slot `note-bar`, spec
// `SPECs/git-sync-spec.md` "Merge view"): "Changed on another device — Resolve". It never opens the
// merge view by itself, and never touches the buffer: autosave keeps writing the user's text
// locally (the conflicted file is never committed), so nothing typed is lost.
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useGitStatus } from "../lib/status-store";
import { openMerge } from "../lib/resolve-conflicts";

/** The vault-relative form of the absolute `path`, `null` outside the vault. */
function relativeTo(root: string | null, path: string): string | null {
  const base = root?.replace(/\/$/, "");
  return base && path.startsWith(`${base}/`) ? path.slice(base.length + 1) : null;
}

export default function GitNoteBar({ path }: { path: string }) {
  const root = useWorkspaceStore((s) => s.root);
  const rel = relativeTo(root, path);
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
