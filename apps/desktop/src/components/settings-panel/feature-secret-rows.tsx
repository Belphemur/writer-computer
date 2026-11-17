import { useEffect, useState } from "react";
import { confirmAction } from "@/lib/tauri";
import type { FeatureSecretDecl } from "@/lib/features/types";
import { useFeatureSecretsStore } from "@/stores/feature-secrets-store";
import { BUTTON, ROW, SecretForm } from "./secret-form";

/** The "Secrets" group of a feature in Settings > Features: one row per declared secret with a
 *  set / not set status, Replace (or Set) and Clear. The stored value is never shown: the store
 *  only knows which keys are set, and the field is write-only (`SecretForm`). */
export function FeatureSecretRows({
  featureId,
  secrets,
}: {
  featureId: string;
  secrets: readonly FeatureSecretDecl[];
}) {
  const keysSet = useFeatureSecretsStore((s) => s.keysSet[featureId]);
  const error = useFeatureSecretsStore((s) => s.errors[featureId]);
  const busy = useFeatureSecretsStore((s) => s.busy);
  const refresh = useFeatureSecretsStore((s) => s.refresh);
  const save = useFeatureSecretsStore((s) => s.save);
  const remove = useFeatureSecretsStore((s) => s.remove);
  const [editing, setEditing] = useState<string | null>(null);

  useEffect(() => {
    void refresh(featureId);
  }, [refresh, featureId]);

  async function clear(secret: FeatureSecretDecl) {
    const ok = await confirmAction(
      `Clear "${secret.label}"? The feature will no longer find a value.`,
      "Clear secret",
    );
    if (ok) await remove(featureId, secret.key);
  }

  return (
    <div data-feature-secrets={featureId} className="[&:first-child>h3]:mt-0">
      <h3 className="mb-2 mt-4 text-[13px] font-medium text-[var(--text-muted)]">Secrets</h3>
      {error && (
        <div role="alert" className="mb-2 text-[13px] text-red-500">
          {error}
        </div>
      )}
      <div className="overflow-hidden rounded-2xl border border-[var(--line-subtler)] bg-[var(--surface-card)]">
        {secrets.map((secret, i) => {
          const isSet = keysSet?.includes(secret.key) === true;
          return (
            <div
              key={secret.key}
              data-feature-secret={secret.key}
              className={i === 0 ? undefined : "border-t border-[var(--line-subtler)]"}
            >
              <div className={ROW}>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] text-[var(--text-primary)]">
                    {secret.label}{" "}
                    <span data-secret-status className="text-[var(--text-muted)]">
                      {keysSet === undefined ? "…" : isSet ? "Set" : "Not set"}
                    </span>
                  </div>
                  {secret.description && (
                    <div className="mt-0.5 text-[13px] text-[var(--text-muted)]">
                      {secret.description}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    className={BUTTON}
                    aria-label={`${isSet ? "Replace" : "Set"} ${secret.label}`}
                    onClick={() => setEditing(editing === secret.key ? null : secret.key)}
                  >
                    {isSet ? "Replace" : "Set"}
                  </button>
                  {isSet && (
                    <button
                      type="button"
                      className={BUTTON}
                      disabled={busy}
                      aria-label={`Clear ${secret.label}`}
                      onClick={() => void clear(secret)}
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>
              {editing === secret.key && (
                <div className="px-4 pb-3">
                  <SecretForm
                    busy={busy}
                    fixedName={secret.key}
                    label={`New value for ${secret.label}`}
                    submitLabel="Save"
                    onCancel={() => setEditing(null)}
                    onSubmit={async (key, value) => {
                      const ok = await save(featureId, key, value);
                      if (ok) setEditing(null);
                      return ok;
                    }}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
