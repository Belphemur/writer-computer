import { HugeiconsIcon } from "@hugeicons/react";
import { Search01Icon } from "@hugeicons/core-free-icons";
import { INPUT } from "./select-row";

/** The search field of a settings list (the models table, the MCP servers menu): a magnifier in
 *  the input's left padding, `label` for assistive tech, the placeholder "Search". Extra props
 *  (`data-*`) go to the input. */
export function SearchField({
  label,
  value,
  onChange,
  className = "block min-w-[140px] flex-1",
  ...rest
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
} & { [attr: `data-${string}`]: string | boolean | undefined }) {
  return (
    <label className={`relative ${className}`}>
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-icon-muted)]">
        <HugeiconsIcon icon={Search01Icon} size={14} strokeWidth={1.75} aria-hidden="true" />
      </span>
      <input
        {...rest}
        type="search"
        aria-label={label}
        placeholder="Search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`${INPUT} pl-8`}
      />
    </label>
  );
}
