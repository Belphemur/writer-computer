import { useState } from "react";

export function StringControl({
  value,
  placeholder,
  onChange,
}: {
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
}) {
  // A non-null draft belongs to the active edit. External persistence updates
  // remain visible when idle, but cannot replace newer typing after a commit.
  const [draft, setDraft] = useState<string | null>(null);
  const displayedValue = draft ?? value;

  const commit = () => {
    if (displayedValue !== value) onChange(displayedValue);
    setDraft(null);
  };

  return (
    <input
      type="text"
      value={displayedValue}
      placeholder={placeholder}
      aria-label="Text value"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
      className="w-64 h-9 rounded-lg border border-transparent bg-[var(--surface-input)] px-3 text-[13px] text-[var(--text-secondary)] font-[inherit] outline-none focus:border-[var(--focus-border)] focus-visible:outline-none"
    />
  );
}
