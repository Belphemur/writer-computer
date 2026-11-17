import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ArrowDown01Icon, Folder01Icon } from "@hugeicons/core-free-icons";
import { openNewProjectDialog, setAgentView, startNewAgentChat } from "@/hooks/agent-api";
import { useWorkspaceRoot } from "@/hooks/use-workspace";
import { useAgentStore } from "@/stores/agent-store";
import { useProjectsStore } from "@/stores/projects-store";
import { Ico } from "./agent-icon";

/**
 * The header title as a project switcher (spec 4.6). `projectPath` is the active chat's project
 * (vault-relative folder, null = vault root). Picking a project makes it the default for new
 * chats and starts a chat in it; "No project" does the same for the vault root. The popover has
 * a filter box, "Project home" and "New project". Mounted by `ProjectSwitcherSlot` in `slots.tsx`.
 */
export function ProjectSwitcher({ projectPath }: { projectPath: string | null }) {
  const root = useWorkspaceRoot();
  const projects = useProjectsStore((s) => s.projects);
  const loadedRoot = useProjectsStore((s) => s.loadedRoot);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  // Load the list the first time the switcher is shown for this workspace.
  useEffect(() => {
    if (root && loadedRoot !== root) void useProjectsStore.getState().refresh();
  }, [root, loadedRoot]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const vaultName = root ? (root.split("/").filter(Boolean).pop() ?? "Vault") : "Agent";
  const current = projects.find((p) => p.path === projectPath);
  const label = projectPath
    ? (current?.name ?? projectPath.split("/").pop() ?? projectPath)
    : vaultName;

  const options = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const rows: { key: string; path: string | null; text: string; detail: string }[] = [];
    if (q === "" || "no project".includes(q) || vaultName.toLowerCase().includes(q)) {
      rows.push({ key: "root", path: null, text: "No project", detail: "Vault root" });
    }
    for (const p of projects) {
      if (q === "" || p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q)) {
        rows.push({ key: p.path, path: p.path, text: p.name, detail: p.path });
      }
    }
    return rows;
  }, [filter, projects, vaultName]);

  function choose(path: string | null) {
    useAgentStore.setState({ currentProjectPath: path });
    startNewAgentChat(path);
    setOpen(false);
    setFilter("");
  }

  return (
    <div ref={wrapRef} className="relative min-w-0" data-agent-project-slot>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        title={projectPath ?? "Vault"}
        onClick={() => {
          setOpen((o) => !o);
          setActive(0);
        }}
        className="flex min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-[13px] font-medium text-text-primary hover:bg-[var(--item-hover-bg)]"
      >
        <Ico icon={Folder01Icon} size={14} className="shrink-0 text-text-icon-muted" />
        <span className="truncate">{label}</span>
        <Ico icon={ArrowDown01Icon} size={12} className="shrink-0 text-text-icon-muted" />
      </button>
      {open ? (
        <div className="absolute left-0 top-full z-50 mt-1 w-72 rounded-lg border border-[var(--border-color)] bg-[var(--surface-primary)] p-1 shadow-lg">
          <input
            autoFocus
            type="text"
            aria-label="Filter projects"
            placeholder="Filter projects"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((i) => Math.min(i + 1, options.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                const o = options[active];
                if (o) choose(o.path);
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setOpen(false);
              }
            }}
            className="mb-1 h-8 w-full rounded-md bg-[var(--surface-input)] px-2 text-[12px] text-[var(--text-secondary)] outline-none"
          />
          <ul id={listId} role="listbox" aria-label="Projects" className="max-h-60 overflow-y-auto">
            {options.map((o, i) => (
              <li
                key={o.key}
                role="option"
                aria-selected={o.path === projectPath}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(o.path);
                }}
                className={`flex cursor-pointer items-baseline gap-2 rounded-md px-2 py-1.5 text-[13px] ${
                  i === active ? "bg-[var(--item-hover-bg)]" : ""
                }`}
              >
                <span className="truncate text-[var(--text-primary)]">{o.text}</span>
                <span className="truncate text-[12px] text-[var(--text-muted)]">{o.detail}</span>
              </li>
            ))}
            {options.length === 0 ? (
              <li className="px-2 py-1.5 text-[12px] text-[var(--text-muted)]">
                No matching project
              </li>
            ) : null}
          </ul>
          <div className="mt-1 border-t border-[var(--line-subtle)] pt-1">
            {projectPath ? (
              <button
                type="button"
                onClick={() => {
                  setAgentView("project");
                  setOpen(false);
                }}
                className="w-full rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-[var(--item-hover-bg)]"
              >
                Project home
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                openNewProjectDialog();
              }}
              className="w-full rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-[var(--item-hover-bg)]"
            >
              New project
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
