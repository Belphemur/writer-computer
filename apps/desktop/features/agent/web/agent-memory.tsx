import { useCallback, useEffect, useState } from "react";
import { linkHandlers, openPath } from "@/lib/link-activation";
import { useAgentProjectPath } from "@features/agent/web/hooks/use-agent";
import { logger } from "@/lib/logger";
import { revealInFileManager } from "@/lib/tauri";
import { SettingRows } from "@/components/settings-panel/setting-rows";
import { SETTINGS_SCHEMA } from "@/lib/settings-schema";
import { callAgent, type ImportReport, type MemoryFolder, type MemoryOverview } from "./ipc";

// Settings > Agent > Memory (ADR "Keep agent memory in the vault ..."): the `agent.memory` mode,
// where the memory lives, the files in it (open as a normal note tab, delete), "Forget all" and
// the one-time import from Claude Code. Everything goes through the agent's async commands, which
// confine every path to the vault; this file never builds a path. File names and contents are
// never logged.

const CARD =
  "overflow-hidden rounded-2xl border border-[var(--line-subtler)] bg-[var(--surface-card)]";
const BUTTON =
  "shrink-0 rounded-lg border border-[var(--line-subtle)] px-3 py-1.5 text-[13px] text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-subtle-strong)] disabled:opacity-50";
const SMALL =
  "shrink-0 rounded-md px-2 py-1 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--item-hover-bg)] hover:text-[var(--text-primary)] disabled:opacity-50";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function size(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/** The overview of the vault and (with `projectPath`) the project, reloaded on demand. */
function useMemoryOverview(projectPath: string | null) {
  const [overview, setOverview] = useState<MemoryOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      setOverview(await callAgent("agent_memory_list", { projectPath }));
    } catch (e) {
      setError(message(e));
    }
  }, [projectPath]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { overview, error, setError, reload };
}

function FolderCard({
  title,
  folder,
  projectPath,
  onChanged,
  onError,
}: {
  title: string;
  folder: MemoryFolder;
  projectPath: string | null;
  onChanged: () => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const scope = folder.scope;

  async function run(action: () => Promise<unknown>) {
    onError(null);
    try {
      await action();
    } catch (e) {
      onError(message(e));
      logger.warn("agent", "memory action failed");
    }
    await onChanged();
  }

  return (
    <div className={`${CARD} mb-4`} data-agent-memory-folder={scope}>
      <div className="flex items-start justify-between gap-4 px-4 py-3.5">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-[var(--text-primary)]">{title}</div>
          <div
            data-agent-memory-path
            className="mt-0.5 select-text break-all font-mono text-[12px] text-[var(--text-muted)]"
          >
            {folder.path}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            className={BUTTON}
            disabled={!folder.exists}
            onClick={() => void run(() => revealInFileManager(folder.path))}
          >
            Open folder
          </button>
          {confirming ? (
            <span className="flex items-center gap-1" role="group" aria-label="Confirm forget all">
              <button
                type="button"
                className={`${BUTTON} text-[var(--danger)]`}
                onClick={() => {
                  setConfirming(false);
                  void run(() => callAgent("agent_memory_forget_all", { scope, projectPath }));
                }}
              >
                Forget all
              </button>
              <button type="button" className={SMALL} onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </span>
          ) : (
            <button
              type="button"
              className={BUTTON}
              disabled={folder.files.length === 0}
              onClick={() => setConfirming(true)}
            >
              Forget all…
            </button>
          )}
        </div>
      </div>
      {folder.files.length === 0 ? (
        <div className="border-t border-[var(--line-subtler)] px-4 py-3 text-[13px] text-[var(--text-muted)]">
          Nothing saved yet.
        </div>
      ) : (
        <ul className="m-0 list-none p-0">
          {folder.files.map((f) => (
            <li
              key={f.name}
              data-agent-memory-file={f.name}
              className="flex items-center justify-between gap-3 border-t border-[var(--line-subtler)] px-4 py-2"
            >
              <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--text-primary)]">
                {f.name}
              </span>
              <span className="shrink-0 text-[12px] text-[var(--text-muted)]">{size(f.bytes)}</span>
              <button
                type="button"
                className={SMALL}
                aria-label={`Open ${f.name}`}
                {...linkHandlers({
                  kind: "custom",
                  open: (intent) =>
                    void run(() =>
                      openPath(f.path, intent === "current" ? "new-tab-active" : intent),
                    ),
                })}
              >
                Open
              </button>
              <button
                type="button"
                className={SMALL}
                aria-label={`Delete ${f.name}`}
                onClick={() =>
                  void run(() =>
                    callAgent("agent_memory_delete", { scope, projectPath, name: f.name }),
                  )
                }
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function reportText(r: ImportReport): string {
  if (r.foldersFound === 0)
    return "No Claude Code memory was found for this vault or its projects.";
  if (r.imported === 0) return "Nothing new to import: everything is already in the vault.";
  return `Imported ${r.imported} file${r.imported === 1 ? "" : "s"}${
    r.skipped ? `, ${r.skipped} skipped` : ""
  }.`;
}

function ImportRow({ onImported }: { onImported: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    try {
      setResult(reportText(await callAgent("agent_memory_import_claude", {})));
    } catch (e) {
      setResult(`Import failed: ${message(e)}`);
    } finally {
      setBusy(false);
    }
    await onImported();
  }

  return (
    <div className={`${CARD} flex items-center justify-between gap-4 px-4 py-3.5`}>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-[var(--text-primary)]">
          Import from Claude Code
        </div>
        <div className="mt-0.5 text-[13px] text-[var(--text-muted)]">
          Copies what Claude Code already remembers for this vault and its projects into the folders
          above. Existing files are never overwritten and nothing is deleted from Claude Code.
        </div>
        {result && (
          <div role="status" data-agent-memory-import-result className="mt-1.5 text-[13px]">
            {result}
          </div>
        )}
      </div>
      <button type="button" className={BUTTON} disabled={busy} onClick={() => void run()}>
        {busy ? "Importing…" : "Import"}
      </button>
    </div>
  );
}

export function AgentMemory() {
  const projectPath = useAgentProjectPath();
  const { overview, error, setError, reload } = useMemoryOverview(projectPath);
  const mode = SETTINGS_SCHEMA.filter((d) => d.key === "agent.memory");

  return (
    <div data-agent-memory>
      <h2 className="mt-8 mb-1 text-[13px] font-medium text-[var(--text-muted)]">Memory</h2>
      <p className="mb-3 text-[13px] text-[var(--text-muted)]">
        What the agent remembers across chats is saved as plain Markdown. Anyone who has the vault
        can read it, so do not ask the agent to remember secrets. A vault chat sees the vault
        memory; a project chat also sees its project&apos;s.
      </p>
      <SettingRows defs={mode} />
      {error && (
        <div role="alert" className="mt-3 text-[13px] text-[var(--danger)]">
          {error}
        </div>
      )}
      <div className="mt-3">
        {overview && (
          <>
            <FolderCard
              title="Vault memory"
              folder={overview.vault}
              projectPath={null}
              onChanged={reload}
              onError={setError}
            />
            {overview.project && (
              <FolderCard
                title="Project memory"
                folder={overview.project}
                projectPath={projectPath}
                onChanged={reload}
                onError={setError}
              />
            )}
          </>
        )}
        <ImportRow onImported={reload} />
      </div>
    </div>
  );
}
