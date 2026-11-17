import { useCallback, useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useSetSetting, useSetting } from "@/hooks/use-settings";
import { useWorkspaceRoot } from "@/hooks/use-workspace";
import { chatHistoryClient } from "@features/agent/web/lib/chat-history-client";

const BUTTON =
  "shrink-0 rounded-lg border border-[var(--line-subtle)] px-3 py-1.5 text-[13px] text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-subtle-strong)] disabled:opacity-50";

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** "Locate…": pick the `claude` program and store it as `agent.binary-path`. */
export async function locateBinary(): Promise<string | null> {
  const picked = await openDialog({
    directory: false,
    multiple: false,
    title: "Choose the claude program",
  });
  return typeof picked === "string" ? picked : null;
}

function SavedRules() {
  const root = useWorkspaceRoot();
  const [rules, setRules] = useState<{ allow: string[]; deny: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setRules(await chatHistoryClient.permissionRules(null));
      setError(null);
    } catch (e) {
      setError(describe(e));
    }
  }, []);
  useEffect(() => {
    if (root) void load();
  }, [root, load]);
  if (!root) return null;
  async function remove(rule: string) {
    try {
      await chatHistoryClient.removePermissionRule(null, rule);
      await load();
    } catch (e) {
      setError(describe(e));
    }
  }
  const all = [
    ...(rules?.allow ?? []).map((r) => ({ r, kind: "Allow" })),
    ...(rules?.deny ?? []).map((r) => ({ r, kind: "Deny" })),
  ];
  return (
    <section data-agent-rules className="mt-5">
      <h3 className="text-[13px] font-medium text-[var(--text-primary)]">Saved permission rules</h3>
      <p className="mt-1 mb-2 text-[12px] text-[var(--text-muted)]">
        Rules from &quot;Always allow&quot; in the vault root, kept by Claude Code in{" "}
        <code>.claude/settings.local.json</code>. Rules in your own{" "}
        <code>~/.claude/settings.json</code> also apply but are not edited here.
      </p>
      <div className="overflow-hidden rounded-xl border border-[var(--line-subtler)]">
        {all.length === 0 && (
          <div className="px-3 py-2.5 text-[13px] text-[var(--text-muted)]">
            {error ? `Could not read the rules: ${error}` : "No saved rules."}
          </div>
        )}
        {all.map(({ r, kind }, i) => (
          <div
            key={`${kind}:${r}`}
            className={`flex items-center justify-between gap-3 px-3 py-2 ${
              i === 0 ? "" : "border-t border-[var(--line-subtler)]"
            }`}
          >
            <span className="min-w-0 flex-1 select-text break-all font-mono text-[12px] text-[var(--text-primary)]">
              <span className="mr-2 text-[var(--text-muted)]">{kind}</span>
              {r}
            </span>
            <button type="button" className={BUTTON} onClick={() => void remove(r)}>
              Remove
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Configure dialog of the Claude backend: the program path override (`agent.binary-path`) and the
 *  saved permission rules. Only documented settings live here: no extra arguments, nothing that
 *  could reach `--dangerously-skip-permissions`. */
export function AgentConfigureDialog({
  onClose,
  onRedetect,
}: {
  onClose: () => void;
  onRedetect: () => void;
}) {
  const path = useSetting("agent.binary-path") ?? "";
  const setSetting = useSetSetting();
  const [draft, setDraft] = useState(path);
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => card.current?.focus(), []);

  function commit(value: string) {
    void setSetting("agent.binary-path", value.trim());
    onRedetect();
  }

  async function locate() {
    const picked = await locateBinary();
    if (picked) {
      setDraft(picked);
      commit(picked);
    }
  }

  return (
    <div
      className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center px-6 py-6"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={card}
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-configure-title"
        tabIndex={-1}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
        className="flex max-h-[calc(100vh-3rem)] w-full max-w-[520px] flex-col overflow-y-auto rounded-xl border border-[var(--border-color)] bg-[var(--surface-card)] p-5 outline-none"
      >
        <h2
          id="agent-configure-title"
          className="text-[15px] font-semibold text-[var(--text-primary)]"
        >
          Configure Claude
        </h2>
        <label className="mt-4 block">
          <span className="text-[12px] font-medium text-[var(--text-secondary)]">
            Claude program
          </span>
          <div className="mt-1.5 flex gap-2">
            <input
              type="text"
              value={draft}
              aria-label="Claude program path"
              placeholder="Auto-detect"
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => draft.trim() !== path && commit(draft)}
              onKeyDown={(e) => e.key === "Enter" && commit(draft)}
              className="h-9 min-w-0 flex-1 rounded-lg border border-transparent bg-[var(--surface-input)] px-3 font-mono text-[12px] text-[var(--text-secondary)] outline-none focus:border-[var(--focus-border)]"
            />
            <button type="button" className={BUTTON} onClick={() => void locate()}>
              Locate…
            </button>
          </div>
          <span className="mt-1 block text-[12px] text-[var(--text-muted)]">
            An absolute path to an executable file. Leave blank to search PATH, your login shell and
            the usual install folders.
          </span>
        </label>
        <SavedRules />
        <div className="mt-5 flex justify-end">
          <button type="button" className={BUTTON} onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
