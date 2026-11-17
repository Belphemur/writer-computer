import { useEffect, useRef, useState } from "react";
import { startNewAgentChat } from "@features/agent/web/hooks/agent-api";
import { useWorkspaceRoot } from "@/hooks/use-workspace";
import {
  projectClient,
  type FolderInspection,
  type ProjectClient,
  type ProjectDetail,
} from "@features/agent/web/lib/project-client";
import {
  DEFAULT_PROJECT_PARENT,
  addChip,
  checkParent,
  checkProjectName,
  chipFromCandidate,
  chipFromTag,
  normalizeParent,
  projectFolderPath,
  type SourceChip,
} from "@features/agent/web/lib/project-sources";
import { useAgentStore } from "@features/agent/web/stores/agent-store";
import { useProjectsStore } from "@features/agent/web/stores/projects-store";
import { VaultPickerInput } from "./vault-picker-input";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const FIELD =
  "w-full rounded-lg border border-transparent bg-[var(--surface-input)] px-3 text-[13px] text-[var(--text-secondary)] outline-none focus:border-[var(--focus-border)]";

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Something went wrong.";
}

/** What the dialog does when it finishes: show the project in the pane with a fresh chat. */
export function openProjectInPane(project: ProjectDetail): void {
  useAgentStore.setState({ currentProjectPath: project.path, view: "chat" });
  startNewAgentChat(project.path);
}

/**
 * The one project dialog (spec 4.4). Rendered from the agent store's `newProjectDialog` state, so
 * the pane header, the palette and the sidebar's "Make project" all open this same component.
 * `folder` set means convert mode: the folder already exists and is only adopted.
 */
export function NewProjectDialog({ client = projectClient }: { client?: ProjectClient }) {
  const dialog = useAgentStore((s) => s.newProjectDialog);
  const close = useAgentStore((s) => s.closeNewProjectDialog);
  const root = useWorkspaceRoot();
  useEffect(() => {
    if (!root && dialog.open) close();
  }, [root, dialog.open, close]);
  if (!dialog.open || !root) return null;
  return (
    <DialogBody
      key={dialog.folder ?? "new"}
      folder={dialog.folder}
      onClose={close}
      client={client}
    />
  );
}

function DialogBody({
  folder,
  onClose,
  client,
}: {
  folder: string | null;
  onClose: () => void;
  client: ProjectClient;
}) {
  const convert = folder !== null;
  const [name, setName] = useState("");
  const [parent, setParent] = useState(DEFAULT_PROJECT_PARENT);
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [chips, setChips] = useState<SourceChip[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [inspection, setInspection] = useState<FolderInspection | null>(null);
  const [createAgentsMd, setCreateAgentsMd] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);

  // Convert mode: look at the folder so the dialog says what will and will not be written.
  useEffect(() => {
    if (folder === null) return;
    let stale = false;
    client
      .inspectFolder(folder)
      .then((i) => {
        if (stale) return;
        setInspection(i);
        setCreateAgentsMd(!i.hasAgentsMd);
      })
      .catch((e: unknown) => {
        if (!stale) setError(describe(e));
      });
    return () => {
      stale = true;
    };
  }, [folder, client]);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (firstFieldRef.current ?? cardRef.current)?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      const card = cardRef.current;
      if (!card) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === card)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      } else if (!card.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      previous?.focus();
    };
  }, [onClose]);

  const nameCheck = checkProjectName(name);
  const parentError = checkParent(parent);
  const folderName = folder ? (folder.split("/").pop() ?? folder) : "";
  const target = convert
    ? (folder ?? "")
    : nameCheck.ok
      ? projectFolderPath(parent, nameCheck.name)
      : null;
  const agentsExists = convert && inspection?.hasAgentsMd === true;
  const canSubmit = !busy && (convert ? inspection !== null : nameCheck.ok && parentError === null);

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const inclusions = chips.map((c) => c.raw);
      const project = convert
        ? await client.make({
            path: folder,
            createAgentsMd: !agentsExists && createAgentsMd,
            instructions: agentsExists ? undefined : instructions,
            description,
            inclusions,
          })
        : await client.create({
            name: nameCheck.ok ? nameCheck.name : name,
            parent: normalizeParent(parent),
            description,
            inclusions,
            instructions,
          });
      void useProjectsStore.getState().refresh();
      onClose();
      openProjectInPane(project);
    } catch (e) {
      setError(describe(e));
      setBusy(false);
    }
  }

  function addTag(text: string): boolean {
    const chip = chipFromTag(text);
    if (!chip) {
      setError("A tag cannot contain spaces or commas.");
      return false;
    }
    setError(null);
    setChips((cs) => addChip(cs, chip));
    return true;
  }

  const title = convert ? "Make project" : "New project";
  return (
    <div
      className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center px-6 py-6"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-project-title"
        tabIndex={-1}
        className="relative flex max-h-[calc(100vh-3rem)] w-full max-w-[480px] flex-col rounded-xl border border-[var(--border-color)] bg-[var(--surface-card)] outline-none"
      >
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="min-h-0 overflow-y-auto px-5 pb-2 pt-5">
            <h2
              id="new-project-title"
              className="text-[15px] font-semibold text-[var(--text-primary)]"
            >
              {title}
            </h2>
            <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-muted)]">
              A project is a folder with a <code>project.md</code> and its own{" "}
              <code>AGENTS.md</code>. The agent runs inside it.
            </p>

            {convert ? (
              <div className="mt-4">
                <span className="text-[12px] font-medium text-[var(--text-secondary)]">Folder</span>
                <div
                  className="mt-1.5 truncate text-[13px] text-[var(--text-primary)]"
                  title={folder ?? ""}
                >
                  {folder}
                </div>
                {inspection?.isProject ? (
                  <p className="mt-1.5 text-[12px] leading-relaxed text-[var(--text-muted)]">
                    {folderName} is already a project. Only missing keys are added; nothing is
                    overwritten.
                  </p>
                ) : inspection?.hasProjectMd ? (
                  <p className="mt-1.5 text-[12px] leading-relaxed text-[var(--text-muted)]">
                    This folder has a <code>project.md</code> without a project id. The id and name
                    are added and the rest is left alone.
                  </p>
                ) : null}
              </div>
            ) : (
              <>
                <label className="mt-4 block">
                  <span className="text-[12px] font-medium text-[var(--text-secondary)]">Name</span>
                  <input
                    ref={firstFieldRef}
                    type="text"
                    value={name}
                    placeholder="Client X"
                    aria-invalid={name !== "" && !nameCheck.ok}
                    onChange={(e) => {
                      setName(e.target.value);
                      if (error) setError(null);
                    }}
                    className={`${FIELD} mt-1.5 h-9`}
                  />
                  {name !== "" && !nameCheck.ok ? (
                    <span className="mt-1 block text-[12px] text-[var(--text-muted)]">
                      {nameCheck.reason}
                    </span>
                  ) : null}
                </label>
                <div className="mt-3">
                  <span className="text-[12px] font-medium text-[var(--text-secondary)]">
                    Location
                  </span>
                  <div className="mt-1.5">
                    <VaultPickerInput
                      label="Location"
                      kinds={["folder"]}
                      value={parent}
                      onValueChange={setParent}
                      keepValue
                      onPick={(c) => setParent(c.path)}
                    />
                  </div>
                  {parentError ? (
                    <span className="mt-1 block text-[12px] text-[var(--text-muted)]">
                      {parentError}
                    </span>
                  ) : target ? (
                    <span className="mt-1 block truncate text-[12px] text-[var(--text-muted)]">
                      Creates {target}/
                    </span>
                  ) : null}
                </div>
              </>
            )}

            <label className="mt-3 block">
              <span className="text-[12px] font-medium text-[var(--text-secondary)]">
                Description <span className="font-normal text-[var(--text-muted)]">(optional)</span>
              </span>
              <input
                ref={convert ? firstFieldRef : undefined}
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value.replace(/[\r\n]+/g, " "))}
                className={`${FIELD} mt-1.5 h-9`}
              />
            </label>

            <div className="mt-3">
              <span className="text-[12px] font-medium text-[var(--text-secondary)]">
                Context sources{" "}
                <span className="font-normal text-[var(--text-muted)]">(optional)</span>
              </span>
              {chips.length > 0 ? (
                <ul className="mt-1.5 flex flex-wrap gap-1.5" aria-label="Context sources">
                  {chips.map((c) => (
                    <li
                      key={c.raw}
                      className="flex items-center gap-1 rounded-md bg-[var(--surface-subtle)] py-0.5 pl-2 pr-1 text-[12px] text-[var(--text-secondary)]"
                    >
                      <span className="max-w-[240px] truncate">{c.label}</span>
                      <button
                        type="button"
                        aria-label={`Remove ${c.label}`}
                        onClick={() => setChips((cs) => cs.filter((x) => x.raw !== c.raw))}
                        className="rounded px-1 text-[var(--text-muted)] hover:bg-[var(--item-hover-bg)]"
                      >
                        &times;
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="mt-1.5">
                <VaultPickerInput
                  label="Add a folder or note"
                  placeholder="Add a folder or note"
                  kinds={["folder", "note"]}
                  onPick={(c) => setChips((cs) => addChip(cs, chipFromCandidate(c)))}
                />
              </div>
              <div className="mt-1.5">
                <input
                  type="text"
                  aria-label="Add a tag"
                  placeholder="Add a tag, then Enter"
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      if (tagInput.trim() && addTag(tagInput)) setTagInput("");
                    }
                  }}
                  className={`${FIELD} h-9`}
                />
              </div>
              <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-muted)]">
                A focus aid for the agent, not a permission boundary. Notes are read on demand.
              </p>
            </div>

            {agentsExists ? (
              <p className="mt-3 text-[12px] leading-relaxed text-[var(--text-muted)]">
                This folder already has an <code>AGENTS.md</code>. It is kept as it is.
              </p>
            ) : (
              <>
                {convert ? (
                  <label className="mt-3 flex items-center gap-2 text-[12px] text-[var(--text-secondary)]">
                    <input
                      type="checkbox"
                      checked={createAgentsMd}
                      onChange={(e) => setCreateAgentsMd(e.target.checked)}
                    />
                    Create AGENTS.md
                  </label>
                ) : null}
                {!convert || createAgentsMd ? (
                  <label className="mt-3 block">
                    <span className="text-[12px] font-medium text-[var(--text-secondary)]">
                      Instructions{" "}
                      <span className="font-normal text-[var(--text-muted)]">(optional)</span>
                    </span>
                    <textarea
                      value={instructions}
                      onChange={(e) => setInstructions(e.target.value)}
                      rows={4}
                      placeholder="Seeds AGENTS.md. Leave empty for a short template."
                      className={`${FIELD} mt-1.5 resize-y py-2 leading-relaxed`}
                    />
                  </label>
                ) : null}
              </>
            )}

            {error ? (
              <p
                role="alert"
                className="mt-3 text-[12px] leading-relaxed text-[var(--text-primary)]"
              >
                {error}
              </p>
            ) : null}
          </div>
          <div className="flex justify-end gap-2 px-5 pb-5 pt-3">
            <button
              type="button"
              onClick={onClose}
              className="h-8 rounded-lg px-3 text-[13px] text-[var(--text-secondary)] hover:bg-[var(--item-hover-bg)]"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="h-8 rounded-lg bg-[var(--accent)] px-3 text-[13px] font-medium text-white disabled:opacity-50"
            >
              {convert ? "Make project" : "Create project"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
