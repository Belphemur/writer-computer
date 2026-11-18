import { useEffect, useState } from "react";
import { linkHandlers } from "@/lib/link-activation";
import { useWorkspaceRoot } from "@/hooks/use-workspace";
import { projectClient, type ProjectClient } from "@features/agent/web/lib/project-client";
import { useProjectsStore } from "@features/agent/web/stores/projects-store";

const BUTTON =
  "h-7 shrink-0 rounded-lg px-2.5 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--item-hover-bg)] disabled:opacity-50";

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Something went wrong.";
}

/**
 * The project browser's collapsed "Archived" section (spec 4.6): the projects that sit in the
 * archive folder, each with "Unarchive" (the same command as Archive, the other way round, then
 * the projects store refreshes). A row opens the project's `project.md` like any link (middle
 * click and Cmd/Ctrl+click open a new tab). Hidden while there is nothing to show, unless the
 * palette's "Unarchive project..." expanded it.
 */
export function ArchivedProjects({ client = projectClient }: { client?: ProjectClient }) {
  const root = useWorkspaceRoot();
  const archived = useProjectsStore((s) => s.archived);
  const loadedRoot = useProjectsStore((s) => s.loadedRoot);
  const expanded = useProjectsStore((s) => s.archivedExpanded);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (root && loadedRoot !== root) void useProjectsStore.getState().refresh();
  }, [root, loadedRoot]);

  if (archived.length === 0 && !expanded) return null;

  async function unarchive(path: string) {
    setPending(path);
    setError(null);
    try {
      await client.archive(path, false);
      await useProjectsStore.getState().refresh();
    } catch (e) {
      setError(describe(e));
    } finally {
      setPending(null);
    }
  }

  return (
    <section className="mt-5" data-agent-archived-projects>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => useProjectsStore.getState().setArchivedExpanded(!expanded)}
        className="text-[11px] font-medium uppercase text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
      >
        {expanded ? "▾" : "▸"} Archived ({archived.length})
      </button>
      {expanded ? (
        <>
          {error ? (
            <p role="alert" className="mt-1.5 text-[13px] text-[var(--agent-error)]">
              {error}
            </p>
          ) : null}
          {archived.length === 0 ? (
            <p className="mt-1.5 text-[13px] text-[var(--text-muted)]">No archived projects.</p>
          ) : (
            <ul className="mt-1.5">
              {archived.map((p) => (
                <li key={p.path} className="flex items-center gap-2">
                  <button
                    type="button"
                    {...linkHandlers({
                      kind: "note",
                      path: root ? `${root}/${p.path}/project.md` : p.path,
                    })}
                    className="flex min-w-0 flex-1 items-baseline gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-[var(--item-hover-bg)]"
                  >
                    <span className="truncate text-[var(--text-primary)]">{p.name}</span>
                    <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text-muted)]">
                      {p.path}
                    </span>
                  </button>
                  <button
                    type="button"
                    className={BUTTON}
                    disabled={pending !== null}
                    onClick={() => void unarchive(p.path)}
                  >
                    Unarchive
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
    </section>
  );
}
