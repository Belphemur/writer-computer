import { useState } from "react";
import { isValidSecretId } from "@/lib/secrets-client";

export const ROW = "flex items-center justify-between gap-4 px-4 py-3";
export const BUTTON =
  "shrink-0 rounded-lg border border-[var(--line-subtle)] px-3 py-1.5 text-[13px] text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-subtle-strong)] disabled:opacity-50";
const INPUT =
  "h-9 rounded-lg border border-transparent bg-[var(--surface-input)] px-3 text-[13px] text-[var(--text-secondary)] font-[inherit] outline-none focus:border-[var(--focus-border)]";

/** Write-only value field: the typed value lives in local state until Save and is cleared after.
 *  With `fixedName` the name is the caller's (a declared key: not checked, not editable). Shared by
 *  Settings > Secrets and the secrets of a feature in Settings > Features. */
export function SecretForm({
  fixedName,
  label,
  busy,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  fixedName?: string;
  /** Accessible name of the value field when `fixedName` is set. */
  label?: string;
  busy: boolean;
  submitLabel: string;
  onSubmit: (name: string, value: string) => Promise<boolean>;
  onCancel?: () => void;
}) {
  const [name, setName] = useState(fixedName ?? "");
  const [value, setValue] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  async function submit() {
    if (fixedName === undefined && !isValidSecretId(name)) {
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
          aria-label={fixedName ? (label ?? `New value for ${fixedName}`) : "Secret value"}
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
