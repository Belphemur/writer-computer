import { useCallback, useEffect, useState } from "react";
import { useSetting } from "@/hooks/use-settings";
import { useWorkspaceRoot } from "@/hooks/use-workspace";
import { createTauriAgentClient } from "@/lib/agent/client";
import { chatHistoryClient } from "@/lib/agent/chat-history-client";
import type { AgentBinaryInfo } from "@/lib/agent/events";

const ROW = "flex items-center justify-between gap-4 px-4 py-3";
const BUTTON =
  "shrink-0 rounded-lg border border-[var(--line-subtle)] px-3 py-1.5 text-[13px] text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-subtle-strong)] disabled:opacity-50";
const CARD =
  "overflow-hidden rounded-2xl border border-[var(--line-subtler)] bg-[var(--surface-card)]";

const SOURCE_LABEL: Record<NonNullable<AgentBinaryInfo["source"]>, string> = {
  override: "from the path set above",
  path: "found on PATH",
  "login-path": "found on your login shell's PATH",
  "known-dir": "found in a known install folder",
};

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function BinaryRow() {
  const override = useSetting("agent.binary-path") ?? "";
  const [info, setInfo] = useState<AgentBinaryInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const detect = useCallback(async () => {
    setError(null);
    try {
      setInfo(await createTauriAgentClient().detectBinary({ override: override || null }));
    } catch (e) {
      setError(describe(e));
    }
  }, [override]);
  useEffect(() => {
    void detect();
  }, [detect]);
  return (
    <div className={ROW} data-agent-binary>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-[var(--text-primary)]">
          Detected Claude CLI
        </div>
        <div
          data-agent-binary-status
          className="mt-0.5 select-text break-all font-mono text-[12px] text-[var(--text-muted)]"
        >
          {error
            ? `Could not check: ${error}`
            : info === null
              ? "Looking…"
              : info.found
                ? `${info.path} ${info.version ?? ""}${info.source ? ` (${SOURCE_LABEL[info.source]})` : ""}`
                : "Not found. Set the path above or install Claude Code."}
        </div>
      </div>
      <button type="button" className={BUTTON} onClick={() => void detect()}>
        Re-detect
      </button>
    </div>
  );
}

function RulesBlock() {
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
    <section className="mb-10" data-agent-rules>
      <h2 className="mb-3 text-[13px] font-medium text-[var(--text-muted)]">
        Saved permission rules
      </h2>
      <p className="mb-3 text-[13px] text-[var(--text-muted)]">
        Rules from &quot;Always allow&quot; in the vault root, kept by Claude Code in{" "}
        <code>.claude/settings.local.json</code> (add it to .gitignore if you use git). Rules in
        your own <code>~/.claude/settings.json</code> also apply but are not edited here.
      </p>
      <div className={CARD}>
        {all.length === 0 && (
          <div className={`${ROW} text-[13px] text-[var(--text-muted)]`}>
            {error ? `Could not read the rules: ${error}` : "No saved rules."}
          </div>
        )}
        {all.map(({ r, kind }, i) => (
          <div
            key={`${kind}:${r}`}
            className={`${ROW} ${i === 0 ? "" : "border-t border-[var(--line-subtler)]"}`}
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

/** Settings > Agent: the schema-driven `agent.*` rows are rendered by the category block above
 *  this one; this block adds what the schema cannot express (read-only detection, saved rules). */
export function AgentSection() {
  return (
    <>
      <section className="mb-10" data-agent-section>
        <div className={CARD}>
          <BinaryRow />
        </div>
      </section>
      <RulesBlock />
    </>
  );
}
