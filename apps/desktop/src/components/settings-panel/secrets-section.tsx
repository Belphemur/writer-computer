import { useEffect, useState } from "react";
import { confirmAction } from "@/lib/tauri";
import { isValidSecretId } from "@/lib/secrets-client";
import { useSecretsStore } from "@/stores/secrets-store";

const ROW = "flex items-center justify-between gap-4 px-4 py-3";
const BUTTON =
  "shrink-0 rounded-lg border border-[var(--line-subtle)] px-3 py-1.5 text-[13px] text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-subtle-strong)] disabled:opacity-50";
const INPUT =
  "h-9 rounded-lg border border-transparent bg-[var(--surface-input)] px-3 text-[13px] text-[var(--text-secondary)] font-[inherit] outline-none focus:border-[var(--focus-border)]";

/** Write-only value field: the typed value lives in local state until Save and is cleared after. */
function SecretForm({
  fixedName,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  fixedName?: string;
  submitLabel: string;
  onSubmit: (name: string, value: string) => Promise<boolean>;
  onCancel?: () => void;
}) {
  const [name, setName] = useState(fixedName ?? "");
  const [value, setValue] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const busy = useSecretsStore((s) => s.busy);

  async function submit() {
    if (!isValidSecretId(name)) {
      setProblem("Use lowercase letters, digits and dashes for the name.");
      return;
    }
    if (!value) {
      setProblem("Enter a value.");
      return;
    }
    setProblem(null);
    const ok = await onSubmit(name, value);
    setValue("");
    if (ok && !fixedName) setName("");
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {fixedName === undefined && (
          <input
            type="text"
            value={name}
            placeholder="secret-name"
            aria-label="Secret name"
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setName(e.target.value)}
            className={`${INPUT} w-48`}
          />
        )}
        <input
          type="password"
          value={value}
          placeholder="Value"
          aria-label={fixedName ? `New value for ${fixedName}` : "Secret value"}
          autoComplete="off"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
          className={`${INPUT} w-56`}
        />
        <button type="button" className={BUTTON} disabled={busy} onClick={() => void submit()}>
          {submitLabel}
        </button>
        {onCancel && (
          <button type="button" className={BUTTON} onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
      {problem && (
        <div role="alert" className="text-[13px] text-red-500">
          {problem}
        </div>
      )}
    </div>
  );
}

export function SecretsSection() {
  const { ids, status, error, actionError, busy } = useSecretsStore();
  const refresh = useSecretsStore((s) => s.refresh);
  const save = useSecretsStore((s) => s.save);
  const remove = useSecretsStore((s) => s.remove);
  const [editing, setEditing] = useState<string | null>(null);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function onDelete(id: string) {
    const ok = await confirmAction(
      `Delete the secret "${id}"? Plugins that use it will no longer find a value.`,
      "Delete secret",
    );
    if (ok) await remove(id);
  }

  return (
    <section className="mb-10" data-secrets>
      <p className="mb-4 text-[13px] text-[var(--text-muted)]">
        Secrets such as API keys live in your system keychain and are shared by all plugins and
        vaults. Plugins pick a secret by name; values are never shown here.
      </p>
      {status === "error" && (
        <div
          role="alert"
          data-secrets-error
          className="mb-4 rounded-2xl border border-[var(--line-subtler)] bg-[var(--surface-card)] px-4 py-3 text-[13px] text-red-500"
        >
          Could not read the system keychain: {error}
          <button type="button" className={`${BUTTON} ml-3`} onClick={() => void refresh()}>
            Retry
          </button>
        </div>
      )}
      {actionError && (
        <div role="alert" className="mb-4 text-[13px] text-red-500">
          {actionError}
        </div>
      )}
      {status !== "error" && (
        <div className="mb-6 overflow-hidden rounded-2xl border border-[var(--line-subtler)] bg-[var(--surface-card)]">
          {status !== "ready" ? (
            <div className="px-4 py-3.5 text-[13px] text-[var(--text-muted)]">Loading…</div>
          ) : ids.length === 0 ? (
            <div data-secrets-empty className="px-4 py-3.5 text-[13px] text-[var(--text-muted)]">
              No secrets stored yet. Add one below, or let a plugin create it.
            </div>
          ) : (
            ids.map((id, i) => (
              <div
                key={id}
                data-secret={id}
                className={i === 0 ? undefined : "border-t border-[var(--line-subtler)]"}
              >
                <div className={ROW}>
                  <div className="min-w-0 flex-1 truncate font-mono text-[13px] text-[var(--text-primary)]">
                    {id}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      className={BUTTON}
                      aria-label={`Replace value of ${id}`}
                      onClick={() => setEditing(editing === id ? null : id)}
                    >
                      Replace
                    </button>
                    <button
                      type="button"
                      className={BUTTON}
                      disabled={busy}
                      aria-label={`Delete ${id}`}
                      onClick={() => void onDelete(id)}
                    >
                      Delete
                    </button>
                  </div>
                </div>
                {editing === id && (
                  <div className="px-4 pb-3">
                    <SecretForm
                      fixedName={id}
                      submitLabel="Save"
                      onCancel={() => setEditing(null)}
                      onSubmit={async (name, value) => {
                        const ok = await save(name, value);
                        if (ok) setEditing(null);
                        return ok;
                      }}
                    />
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}
      <h2 className="mb-3 text-[13px] font-medium text-[var(--text-muted)]">Add a secret</h2>
      <SecretForm submitLabel="Add" onSubmit={save} />
    </section>
  );
}
