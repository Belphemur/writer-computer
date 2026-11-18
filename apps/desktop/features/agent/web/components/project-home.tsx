import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { openPath } from "@/lib/link-activation";
import {
  openNewProjectDialog,
  setAgentView,
  startNewAgentChat,
} from "@features/agent/web/hooks/agent-api";
import { useWorkspaceRoot } from "@/hooks/use-workspace";
import { useSetting } from "@/hooks/use-settings";
import {
  projectClient,
  type ManifestPreview,
  type ProjectClient,
  type ProjectDetail,
} from "@features/agent/web/lib/project-client";
import { sourceKindLabel } from "@features/agent/web/lib/project-sources";
import { useAgentStore } from "@features/agent/web/stores/agent-store";
import { useProjectAppearance, useProjectsStore } from "@features/agent/web/stores/projects-store";
import { ArchivedProjects } from "./archived-projects";
import { ProjectActionsMenu } from "./project-actions-menu";
import { ProjectIconPopover } from "./project-icon-picker";
import { ProjectIcon } from "./project-icon";

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Something went wrong.";
}

const BUTTON =
  "h-8 rounded-lg px-3 text-[13px] text-[var(--text-secondary)] hover:bg-[var(--item-hover-bg)] disabled:opacity-50";
const PRIMARY =
  "h-8 rounded-lg bg-[var(--accent)] px-3 text-[13px] font-medium text-white disabled:opacity-50";

/**
 * Project landing (spec 4.6): description, the instructions file, context sources with resolved
 * counts, recent chats and "New chat in project". `recentChats` is the slot lane 4 fills with the
 * project's saved chats; without it the project's open chats are listed.
 */
export function ProjectHome({
  projectPath,
  recentChats,
  client = projectClient,
}: {
  projectPath: string | null;
  recentChats?: ReactNode;
  client?: ProjectClient;
}) {
  const root = useWorkspaceRoot();
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [manifest, setManifest] = useState<ManifestPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const appearance = useProjectAppearance(projectPath);
  const archiveFolder =
    String(useSetting("agent.projects-archive-folder") ?? "").trim() || "Archive/Projects";
  const archiveRequested = useProjectsStore((s) => s.archiveRequested);

  const load = useCallback(
    async (isStale: () => boolean = () => false) => {
      if (!projectPath) return;
      try {
        const detail = await client.read(projectPath);
        if (isStale()) return;
        setProject(detail);
        setError(null);
      } catch (e) {
        if (!isStale()) setError(describe(e));
        return;
      }
      try {
        const m = await client.manifest(projectPath);
        if (!isStale()) setManifest(m);
      } catch {
        if (!isStale()) setManifest(null);
      }
    },
    [client, projectPath],
  );

  useEffect(() => {
    setProject(null);
    setManifest(null);
    setError(null);
    setConfirmArchive(false);
    setPickerOpen(false);
    setMenuOpen(false);
    let stale = false;
    void load(() => stale);
    return () => {
      stale = true;
    };
  }, [load]);

  // The palette's "Archive project" opens the confirm step once the project has loaded.
  useEffect(() => {
    if (!archiveRequested || !project) return;
    useProjectsStore.getState().setArchiveRequested(false);
    setConfirmArchive(true);
  }, [archiveRequested, project]);

  if (!projectPath) {
    return (
      <div data-agent-slot="project-home" className="min-h-0 flex-1 overflow-y-auto p-4">
        <h2 className="text-[14px] font-semibold text-[var(--text-primary)]">No project</h2>
        <p className="mt-1 text-[13px] leading-relaxed text-[var(--text-muted)]">
          Chats run in the vault root. A project gives the agent its own instructions, context
          sources and chats.
        </p>
        <button type="button" className={`${PRIMARY} mt-3`} onClick={() => openNewProjectDialog()}>
          New project
        </button>
        <ArchivedProjects client={client} />
      </div>
    );
  }

  const absolute = (file: string) => (root ? `${root}/${projectPath}/${file}` : null);
  const openNote = (file: string) => {
    const path = absolute(file);
    if (path) void openPath(path, "new-tab-active");
  };

  async function createAgents() {
    setBusy(true);
    try {
      await client.make({ path: projectPath!, createAgentsMd: true });
      await load();
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(false);
    }
  }

  async function archive() {
    setBusy(true);
    try {
      await client.archive(projectPath!, true);
      await useProjectsStore.getState().refresh();
      useAgentStore.setState({ currentProjectPath: null });
      setAgentView("chat");
    } catch (e) {
      setError(describe(e));
      setBusy(false);
      setConfirmArchive(false);
    }
  }

  return (
    <div data-agent-slot="project-home" className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
      <div ref={headerRef} className="relative flex items-center gap-2">
        <ProjectIcon icon={appearance.icon} color={appearance.color} size={18} />
        <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold text-[var(--text-primary)]">
          {project?.name ?? projectPath.split("/").pop()}
        </h2>
        <button
          ref={moreRef}
          type="button"
          className={BUTTON}
          aria-label="Project actions"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((o) => !o)}
        >
          …
        </button>
        {menuOpen ? (
          <ProjectActionsMenu
            projectPath={projectPath}
            anchorRef={moreRef}
            label={`Actions for ${project?.name ?? projectPath}`}
            onChangeIcon={() => setPickerOpen(true)}
            onClose={() => setMenuOpen(false)}
          />
        ) : null}
        {pickerOpen ? (
          <ProjectIconPopover
            projectPath={projectPath}
            anchorRef={headerRef}
            onClose={() => setPickerOpen(false)}
          />
        ) : null}
      </div>
      <p className="truncate text-[12px] text-[var(--text-muted)]" title={projectPath}>
        {projectPath}
      </p>
      {project?.description ? (
        <p className="mt-2 text-[13px] leading-relaxed text-[var(--text-secondary)]">
          {project.description}
        </p>
      ) : null}
      {project?.agentMode === "acceptEdits" ? (
        <p className="mt-2 text-[12px] text-[var(--text-secondary)]">
          Auto-edit is on for this project (<code>writer-agent-mode</code>).
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-[12px] leading-relaxed text-[var(--text-primary)]">
          {error}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          className={PRIMARY}
          disabled={!project}
          onClick={() => startNewAgentChat(projectPath)}
        >
          New chat in project
        </button>
      </div>

      {project ? (
        <>
          <section className="mt-5" aria-labelledby="project-instructions">
            <h3
              id="project-instructions"
              className="text-[11px] font-medium uppercase text-[var(--text-muted)]"
            >
              Instructions
            </h3>
            {project.hasAgentsMd ? (
              <div className="mt-1.5 flex items-center justify-between gap-2">
                <span className="text-[13px] text-[var(--text-secondary)]">AGENTS.md</span>
                <button type="button" className={BUTTON} onClick={() => openNote("AGENTS.md")}>
                  Open
                </button>
              </div>
            ) : (
              <div className="mt-1.5 flex items-center justify-between gap-2">
                <span className="text-[13px] text-[var(--text-muted)]">No AGENTS.md yet</span>
                <button
                  type="button"
                  className={BUTTON}
                  disabled={busy}
                  onClick={() => void createAgents()}
                >
                  Create AGENTS.md
                </button>
              </div>
            )}
            {project.hasClaudeMd ? (
              <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-muted)]">
                This folder also has a CLAUDE.md, which Claude Code prefers. Writer adds the
                AGENTS.md text itself when CLAUDE.md does not import it.
              </p>
            ) : null}
            <div className="mt-1 flex items-center justify-between gap-2">
              <span className="text-[13px] text-[var(--text-secondary)]">project.md</span>
              <button type="button" className={BUTTON} onClick={() => openNote("project.md")}>
                Open
              </button>
            </div>
          </section>

          <section className="mt-4" aria-labelledby="project-sources">
            <h3
              id="project-sources"
              className="text-[11px] font-medium uppercase text-[var(--text-muted)]"
            >
              Context sources
            </h3>
            <SourceList project={project} manifest={manifest} />
          </section>

          <section className="mt-4" aria-labelledby="project-chats">
            <h3
              id="project-chats"
              className="text-[11px] font-medium uppercase text-[var(--text-muted)]"
            >
              Recent chats
            </h3>
            {recentChats ?? <OpenProjectChats projectPath={projectPath} />}
          </section>

          {confirmArchive ? (
            <section className="mt-5">
              <div className="flex items-center gap-2">
                <span className="text-[12px] text-[var(--text-muted)]">
                  Moves the folder to {archiveFolder} and hides the project from pickers. Notes and
                  chats move with it; Unarchive brings it back.
                </span>
                <button
                  type="button"
                  className={BUTTON}
                  disabled={busy}
                  onClick={() => void archive()}
                >
                  Archive
                </button>
                <button type="button" className={BUTTON} onClick={() => setConfirmArchive(false)}>
                  Cancel
                </button>
              </div>
            </section>
          ) : null}
        </>
      ) : null}
      <ArchivedProjects client={client} />
    </div>
  );
}

function SourceList({
  project,
  manifest,
}: {
  project: ProjectDetail;
  manifest: ManifestPreview | null;
}) {
  const entries = manifest?.manifest.entries ?? [];
  const resolved = entries.length > 0;
  const none =
    project.inclusions.length === 0 &&
    project.unsupported.length === 0 &&
    project.webUrls.length === 0 &&
    project.youtubeUrls.length === 0;
  if (none) {
    return (
      <p className="mt-1.5 text-[13px] text-[var(--text-muted)]">
        No sources. The agent works from the folder.
      </p>
    );
  }
  return (
    <ul className="mt-1.5 grid gap-1">
      {(resolved
        ? entries.map((e) => ({
            key: `${e.kind}:${e.label}`,
            kind: e.kind,
            label: e.label,
            count: e.count,
            warning: e.warning,
          }))
        : project.inclusions.map((s) => ({
            key: s.raw,
            kind: s.kind,
            label: s.raw,
            count: null,
            warning: null,
          }))
      ).map((r) => (
        <li key={r.key} className="flex items-baseline gap-2 text-[13px]">
          <span className="w-16 shrink-0 text-[12px] text-[var(--text-muted)]">
            {sourceKindLabel(r.kind)}
          </span>
          <span className="min-w-0 flex-1 truncate text-[var(--text-secondary)]" title={r.label}>
            {r.label}
          </span>
          {r.count !== null ? (
            <span className="shrink-0 text-[12px] text-[var(--text-muted)]">
              {r.count} {r.count === 1 ? "note" : "notes"}
            </span>
          ) : null}
          {r.warning ? (
            <span className="shrink-0 text-[12px] text-[var(--text-muted)]">{r.warning}</span>
          ) : null}
        </li>
      ))}
      {project.unsupported.map((u) => (
        <li key={`unsupported:${u}`} className="flex items-baseline gap-2 text-[13px]">
          <span className="w-16 shrink-0 text-[12px] text-[var(--text-muted)]">Warning</span>
          <span className="min-w-0 flex-1 truncate text-[var(--text-secondary)]" title={u}>
            {u}
          </span>
          <span className="shrink-0 text-[12px] text-[var(--text-muted)]">unsupported source</span>
        </li>
      ))}
      {[...project.webUrls, ...project.youtubeUrls].map((u) => (
        <li key={`url:${u}`} className="flex items-baseline gap-2 text-[13px]">
          <span className="w-16 shrink-0 text-[12px] text-[var(--text-muted)]">Link</span>
          <span className="min-w-0 flex-1 truncate text-[var(--text-secondary)]" title={u}>
            {u}
          </span>
          <span className="shrink-0 text-[12px] text-[var(--text-muted)]">by reference</span>
        </li>
      ))}
    </ul>
  );
}

function OpenProjectChats({ projectPath }: { projectPath: string }) {
  const chats = useAgentStore((s) => s.chats);
  const order = useAgentStore((s) => s.order);
  const ids = order.filter((id) => chats[id]?.projectPath === projectPath);
  if (ids.length === 0) {
    return <p className="mt-1.5 text-[13px] text-[var(--text-muted)]">No chats yet.</p>;
  }
  return (
    <ul className="mt-1.5">
      {ids.map((id) => (
        <li key={id}>
          <button
            type="button"
            onClick={() => useAgentStore.getState().selectChat(id)}
            className="w-full truncate rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-[var(--item-hover-bg)]"
          >
            {chats[id]?.title || "New chat"}
          </button>
        </li>
      ))}
    </ul>
  );
}
