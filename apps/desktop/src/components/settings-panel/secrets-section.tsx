import { useEffect, useState } from "react";
import { confirmAction } from "@/lib/tauri";
import { useSecretsStore } from "@/stores/secrets-store";
import { BUTTON, ROW, SecretForm } from "./secret-form";

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
          className="mb-4 rounded-2xl border border-[var(--line-subtler)] bg-[var(--surface-card)] px-4 py-3 text-[13px] text-[var(--text-secondary)]"
        >
          Writer couldn't read the Keychain — plugins that need API keys will run without them.
          <span className="mt-1 block text-[12px] text-[var(--text-muted)]">{error}</span>
          <button type="button" className={`${BUTTON} mt-2`} onClick={() => void refresh()}>
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
                      busy={busy}
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
      <SecretForm busy={busy} submitLabel="Add" onSubmit={save} />
    </section>
  );
}
