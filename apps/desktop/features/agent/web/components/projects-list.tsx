import { ArchiveRestoreIcon } from "@hugeicons/core-free-icons";
import { useEffect, useMemo, useRef, useState } from "react";
import { linkHandlers } from "@/lib/link-activation";
import { useWorkspaceRoot } from "@/hooks/use-workspace";
import { openNewProjectDialog } from "@features/agent/web/hooks/agent-api";
import { chooseProject } from "@features/agent/web/lib/project-actions";
import {
  projectClient,
  type ProjectClient,
  type ProjectDetail,
} from "@features/agent/web/lib/project-client";
import { useProjectsStore } from "@features/agent/web/stores/projects-store";
import { ProjectActionsMenu } from "./project-actions-menu";
import { ProjectIconPopover } from "./project-icon-picker";
import { ProjectPathIcon } from "./project-icon";
import { ProjectRowLabel } from "./project-row";
import { RowMenu } from "./row-menu";

const DOTS =
  "shrink-0 self-center rounded px-1.5 text-[13px] text-[var(--text-muted)] hover:bg-[var(--item-hover-bg)]";

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Something went wrong.";
}

function matches(p: ProjectDetail, q: string): boolean {
  return q === "" || p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q);
}

/**
 * The Projects list (spec 4.6): the one view that lists projects, active ones first and a
 * collapsed "Archived (n)" group, with a filter and "New project". A row opens that project
 * (the switcher's pick); its "…" (and a right click) holds the project's actions. Nothing about a
 * single project's content lives here: that is the project detail (`project-home.tsx`).
 */
export function ProjectsList({ client = projectClient }: { client?: ProjectClient }) {
  const root = useWorkspaceRoot();
  const projects = useProjectsStore((s) => s.projects);
  const archived = useProjectsStore((s) => s.archived);
  const loadedRoot = useProjectsStore((s) => s.loadedRoot);
  const expanded = useProjectsStore((s) => s.archivedExpanded);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    if (root && loadedRoot !== root) void useProjectsStore.getState().refresh();
  }, [root, loadedRoot]);

  const q = filter.trim().toLowerCase();
  const shown = useMemo(() => projects.filter((p) => matches(p, q)), [projects, q]);
  const shownArchived = useMemo(() => archived.filter((p) => matches(p, q)), [archived, q]);

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
    <div data-agent-slot="projects-list" className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
      <div className="flex items-center gap-2">
        <h2 className="min-w-0 flex-1 text-[15px] font-semibold text-[var(--text-primary)]">
          Projects
        </h2>
        <button
          type="button"
          className="h-8 rounded-lg bg-[var(--accent)] px-3 text-[13px] font-medium text-white"
          onClick={() => openNewProjectDialog()}
        >
          New project
        </button>
      </div>
      <input
        type="text"
        aria-label="Filter projects"
        placeholder="Filter projects"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        className="mt-3 h-8 w-full rounded-md bg-[var(--surface-input)] px-2 text-[12px] text-[var(--text-secondary)] outline-none"
      />
      {projects.length === 0 ? (
        <p className="mt-3 text-[13px] leading-relaxed text-[var(--text-muted)]">
          No projects yet. A project gives the agent its own instructions, context sources and
          chats.
        </p>
      ) : shown.length === 0 ? (
        <p className="mt-3 text-[13px] text-[var(--text-muted)]">No matching project</p>
      ) : (
        <ul className="mt-2" aria-label="Projects">
          {shown.map((p) => (
            <ActiveRow key={p.path} project={p} />
          ))}
        </ul>
      )}
      {archived.length > 0 || expanded ? (
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
                <ul className="mt-1.5" aria-label="Archived projects">
                  {shownArchived.map((p) => (
                    <ArchivedRow
                      key={p.path}
                      project={p}
                      vaultRoot={root}
                      disabled={pending !== null}
                      onUnarchive={() => void unarchive(p.path)}
                    />
                  ))}
                </ul>
              )}
            </>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function ActiveRow({ project }: { project: ProjectDetail }) {
  const [menu, setMenu] = useState(false);
  const [picker, setPicker] = useState(false);
  const rowRef = useRef<HTMLLIElement>(null);
  const dotsRef = useRef<HTMLButtonElement>(null);
  return (
    <li
      ref={rowRef}
      className="relative flex items-center gap-2 rounded-md hover:bg-[var(--item-hover-bg)]"
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu(true);
      }}
    >
      <button
        type="button"
        onClick={() => chooseProject(project.path)}
        className="flex min-w-0 flex-1 items-baseline gap-2 px-2 py-1.5 text-left text-[13px]"
      >
        <ProjectRowLabel
          icon={<ProjectPathIcon path={project.path} />}
          name={project.name}
          detail={project.path}
        />
      </button>
      <button
        ref={dotsRef}
        type="button"
        aria-label={`Actions for ${project.name}`}
        aria-haspopup="menu"
        aria-expanded={menu}
        className={DOTS}
        onClick={() => setMenu((o) => !o)}
      >
        …
      </button>
      {menu ? (
        <ProjectActionsMenu
          projectPath={project.path}
          place="list"
          anchorRef={dotsRef}
          label={`Actions for ${project.name}`}
          onChangeIcon={() => setPicker(true)}
          onClose={() => setMenu(false)}
        />
      ) : null}
      {picker ? (
        <ProjectIconPopover
          projectPath={project.path}
          anchorRef={rowRef}
          onClose={() => setPicker(false)}
        />
      ) : null}
    </li>
  );
}

function ArchivedRow({
  project,
  vaultRoot,
  disabled,
  onUnarchive,
}: {
  project: ProjectDetail;
  vaultRoot: string | null;
  disabled: boolean;
  onUnarchive: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const dotsRef = useRef<HTMLButtonElement>(null);
  return (
    <li
      className="relative flex items-center gap-2 rounded-md hover:bg-[var(--item-hover-bg)]"
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu(true);
      }}
    >
      {/* A row opens the project's note like any link (middle click and Cmd/Ctrl+click: new tab). */}
      <button
        type="button"
        {...linkHandlers({
          kind: "note",
          path: vaultRoot ? `${vaultRoot}/${project.path}/project.md` : project.path,
        })}
        className="flex min-w-0 flex-1 items-baseline gap-2 px-2 py-1.5 text-left text-[13px]"
      >
        <ProjectRowLabel
          icon={<ProjectPathIcon path={project.path} />}
          name={project.name}
          detail={project.path}
        />
      </button>
      <button
        ref={dotsRef}
        type="button"
        aria-label={`Actions for ${project.name}`}
        aria-haspopup="menu"
        aria-expanded={menu}
        className={DOTS}
        onClick={() => setMenu((o) => !o)}
      >
        …
      </button>
      {menu ? (
        <RowMenu
          items={[
            {
              id: "unarchive",
              label: "Unarchive",
              icon: ArchiveRestoreIcon,
              onSelect: onUnarchive,
              disabled,
            },
          ]}
          anchorRef={dotsRef}
          label={`Actions for ${project.name}`}
          onClose={() => setMenu(false)}
        />
      ) : null}
    </li>
  );
}
