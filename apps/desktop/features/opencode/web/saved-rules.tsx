import { useCallback, useEffect, useState } from "react";
import { removeSavedRule, savedRules, type SavedRules } from "./ipc";

const describe = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The "Always allow" rules saved in OpenCode for this vault's project, each with a Remove. While
 *  the project is not known yet the list is every project's: labelled "All projects", read-only. */
export function SavedRules() {
  const [reply, setReply] = useState<SavedRules | null>(null);
  const rules = reply?.rules ?? null;
  const readOnly = reply ? !reply.projectScoped : false;
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setReply(await savedRules());
      setError(null);
    } catch (e) {
      setError(describe(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  async function remove(id: string) {
    try {
      await removeSavedRule(id);
      await load();
    } catch (e) {
      setError(describe(e));
    }
  }
  return (
    <section data-opencode-rules className="border-t border-[var(--line-subtler)] px-4 py-3.5">
      <h3 className="text-[13px] font-medium text-[var(--text-primary)]">
        Saved permission rules
        {readOnly && (
          <span
            data-opencode-rules-scope
            className="ml-2 text-[12px] font-normal text-[var(--text-muted)]"
          >
            All projects
          </span>
        )}
      </h3>
      <div className="mt-2 overflow-hidden rounded-xl border border-[var(--line-subtler)]">
        {(rules ?? []).length === 0 && (
          <div className="px-3 py-2.5 text-[13px] text-[var(--text-muted)]">
            {error ? `Could not read the rules: ${error}` : rules ? "No saved rules." : "Loading…"}
          </div>
        )}
        {(rules ?? []).map((r, i) => (
          <div
            key={r.id}
            data-opencode-rule={r.id}
            className={`flex items-center justify-between gap-3 px-3 py-2 ${
              i === 0 ? "" : "border-t border-[var(--line-subtler)]"
            }`}
          >
            <span className="min-w-0 flex-1 select-text break-all font-mono text-[12px] text-[var(--text-primary)]">
              <span className="mr-2 text-[var(--text-muted)]">{r.action}</span>
              {r.resource}
            </span>
            {!readOnly && (
              <button
                type="button"
                onClick={() => void remove(r.id)}
                className="shrink-0 rounded-lg border border-[var(--line-subtle)] px-3 py-1.5 text-[13px] text-[var(--text-primary)] hover:bg-[var(--surface-subtle-strong)]"
              >
                Remove
              </button>
            )}
          </div>
        ))}
      </div>
      {error && (rules ?? []).length > 0 && (
        <div role="alert" className="mt-1 text-[12px] text-[var(--danger)]">
          {error}
        </div>
      )}
    </section>
  );
}
