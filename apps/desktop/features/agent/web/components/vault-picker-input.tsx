import { useEffect, useId, useState } from "react";
import { searchMentions, type MentionCandidate } from "@features/agent/web/lib/mentions";
import * as tauri from "@/lib/tauri";

type Kind = MentionCandidate["kind"];

/**
 * A text input that suggests vault folders and/or notes as you type (the same candidates as the
 * composer's `@` menu, `web/lib/mentions.ts`). Choosing a suggestion calls `onPick`; the input
 * clears itself unless `keepValue` is set. `onSubmitText` receives Enter on text that matches no
 * highlighted suggestion (used for `#tags`).
 */
export function VaultPickerInput({
  label,
  placeholder,
  kinds,
  onPick,
  onSubmitText,
  value: controlled,
  onValueChange,
  keepValue = false,
  search = (q, n) => tauri.fuzzySearch(q, n),
}: {
  label: string;
  placeholder?: string;
  kinds: readonly Kind[];
  onPick: (candidate: MentionCandidate) => void;
  onSubmitText?: (text: string) => boolean;
  value?: string;
  onValueChange?: (value: string) => void;
  keepValue?: boolean;
  search?: (query: string, limit: number) => Promise<{ relative_path: string }[]>;
}) {
  const [inner, setInner] = useState("");
  const value = controlled ?? inner;
  const setValue = (v: string) => {
    if (controlled === undefined) setInner(v);
    onValueChange?.(v);
  };
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<MentionCandidate[]>([]);
  const [active, setActive] = useState(0);
  const listId = useId();

  useEffect(() => {
    const q = value.trim();
    if (!open || q === "" || q.startsWith("#")) {
      setItems([]);
      return;
    }
    let stale = false;
    const t = setTimeout(() => {
      searchMentions(q, search, 8)
        .then((c) => {
          if (stale) return;
          setItems(c.filter((x) => kinds.includes(x.kind)));
          setActive(0);
        })
        .catch(() => {
          if (!stale) setItems([]);
        });
    }, 60);
    return () => {
      stale = true;
      clearTimeout(t);
    };
    // `kinds` and `search` are stable per call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, open]);

  function pick(c: MentionCandidate) {
    onPick(c);
    setValue(keepValue ? c.path : "");
    setItems([]);
    setOpen(false);
  }

  return (
    <div className="relative">
      <input
        type="text"
        role="combobox"
        aria-label={label}
        aria-expanded={open && items.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onChange={(e) => {
          setValue(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && items.length > 0) {
            e.preventDefault();
            setActive((i) => (i + 1) % items.length);
          } else if (e.key === "ArrowUp" && items.length > 0) {
            e.preventDefault();
            setActive((i) => (i - 1 + items.length) % items.length);
          } else if (e.key === "Enter") {
            const chosen = open ? items[active] : undefined;
            if (chosen) {
              e.preventDefault();
              pick(chosen);
            } else if (onSubmitText && value.trim() !== "") {
              e.preventDefault();
              if (onSubmitText(value)) setValue("");
            }
          } else if (e.key === "Escape" && open && items.length > 0) {
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
          }
        }}
        className="h-9 w-full rounded-lg border border-transparent bg-[var(--surface-input)] px-3 text-[13px] text-[var(--text-secondary)] outline-none focus:border-[var(--focus-border)]"
      />
      {open && items.length > 0 ? (
        <ul
          id={listId}
          role="listbox"
          aria-label={`${label} suggestions`}
          className="absolute left-0 right-0 top-full z-10 mt-1 max-h-48 overflow-y-auto rounded-lg border border-[var(--border-color)] bg-[var(--surface-primary)] p-1 shadow-lg"
        >
          {items.map((c, i) => (
            <li
              key={`${c.kind}:${c.path}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(c);
              }}
              onMouseEnter={() => setActive(i)}
              className={`flex cursor-pointer items-baseline gap-2 rounded-md px-2 py-1 text-[12px] ${
                i === active ? "bg-[var(--item-hover-bg)]" : ""
              }`}
            >
              <span className="text-[var(--text-icon-muted)]">
                {c.kind === "folder" ? "Folder" : "Note"}
              </span>
              <span className="truncate text-[var(--text-primary)]">{c.label}</span>
              {c.detail ? (
                <span className="truncate text-[var(--text-muted)]">{c.detail}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
