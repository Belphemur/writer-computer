import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { typeKey } from "@/lib/property-types";
import { usePropertyTypesStore } from "@/stores/property-types-store";
import { AnchoredPopover } from "./anchored-popover";
import { FIELD } from "./property-chip";

const NO_VALUES: readonly string[] = [];
const ADD = "Add value…";

interface EnumSelectProps {
  /** The note's value; `null` or empty is no value. */
  value: string | null;
  /** The type's allowed values, in order. */
  values: readonly string[];
  ariaLabel: string;
  /** A pick; `null` clears the value. */
  onSelect: (value: string | null) => void;
  /** Append a value to the type; resolves to the stored (trimmed) value, rejects when not saved. */
  onAdd: (value: string) => Promise<string>;
  /** Open on mount (a table cell being edited). */
  defaultOpen?: boolean;
  /** The list closed without a pick (Escape, click outside). */
  onDismiss?: () => void;
  className?: string;
}

type Choice = { kind: "none" } | { kind: "value"; value: string; stray: boolean } | { kind: "add" };

/** An enum value: always a dropdown of the type's values, a way to clear it and an "Add value..."
 *  entry. A value that is not in the list shows marked and stays selectable; it is never changed
 *  until another one is picked. Arrows/Home/End move, Enter picks, Escape closes. */
export function EnumSelect({
  value,
  values,
  ariaLabel,
  onSelect,
  onAdd,
  defaultOpen = false,
  onDismiss,
  className,
}: EnumSelectProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const items = useRef<(HTMLElement | null)[]>([]);
  const current = value === null || value === "" ? null : value;
  const stray = current !== null && !values.includes(current);

  const choices: Choice[] = [
    { kind: "none" },
    ...(stray ? [{ kind: "value", value: current, stray: true } as const] : []),
    ...values.map((v) => ({ kind: "value", value: v, stray: false }) as const),
    { kind: "add" },
  ];
  const selectedIndex = choices.findIndex(
    (c) => (c.kind === "none" && current === null) || (c.kind === "value" && c.value === current),
  );

  const close = (refocus: boolean) => {
    setOpen(false);
    setAdding(false);
    setDraft("");
    setError(null);
    if (refocus) trigger.current?.focus();
    onDismiss?.();
  };
  const pick = (v: string | null) => {
    setOpen(false);
    setAdding(false);
    onSelect(v);
    trigger.current?.focus();
  };
  const add = async () => {
    const v = draft.trim();
    if (v === "") return;
    try {
      pick(await onAdd(v));
    } catch {
      setError("Could not save the value");
    }
  };

  useEffect(() => {
    if (open && !adding) items.current[Math.max(selectedIndex, 0)]?.focus();
    // On open / leaving the add field only: re-renders must not pull focus back from arrows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, adding]);

  const focusItem = (i: number) => items.current[(i + choices.length) % choices.length]?.focus();
  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (adding) return; // the field handles its own keys
    const at = items.current.findIndex((el) => el === document.activeElement);
    if (e.key === "ArrowDown") focusItem(at + 1);
    else if (e.key === "ArrowUp") focusItem(at < 0 ? -1 : at - 1);
    else if (e.key === "Home") focusItem(0);
    else if (e.key === "End") focusItem(-1);
    else if (e.key === "Escape") close(true);
    else if (e.key === "Tab") close(false);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-not-in-list={stray ? "" : undefined}
        onMouseDown={(e) => e.preventDefault()}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            e.stopPropagation();
            setOpen(true);
          } else if (e.key !== "Tab") e.stopPropagation();
        }}
        onClick={() => (open ? close(false) : setOpen(true))}
        className={`${FIELD} flex items-center gap-1.5 text-left ${className ?? ""}`}
      >
        <span
          className={`min-w-0 truncate ${current === null ? "text-[var(--text-muted)] opacity-70" : ""}`}
        >
          {current ?? "empty"}
        </span>
        {stray && <span className="shrink-0 text-[12px] text-[var(--warning)]">not in list</span>}
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          size={12}
          color="currentColor"
          strokeWidth={2}
          className="ml-auto shrink-0 text-[var(--text-icon-muted)]"
        />
      </button>
      {open && (
        <AnchoredPopover
          anchorRef={trigger}
          width={208}
          role="listbox"
          label={ariaLabel}
          onDismiss={() => close(false)}
          onKeyDown={onListKey}
        >
          {choices.map((c, i) => {
            if (c.kind === "add" && adding)
              return (
                <div key="add" className="px-1 py-1">
                  <input
                    // eslint-disable-next-line jsx-a11y/no-autofocus
                    autoFocus
                    aria-label="New value"
                    value={draft}
                    placeholder="New value"
                    onChange={(e) => {
                      setDraft(e.target.value);
                      setError(null);
                    }}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void add();
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        setAdding(false);
                        setDraft("");
                      }
                    }}
                    className="w-full rounded bg-[var(--surface-subtle)] px-2 py-1 text-[13px] leading-[1.4] text-[var(--text-primary)] outline-none focus-visible:ring-1 focus-visible:ring-[var(--focus-border)]"
                  />
                  {error && (
                    <p role="alert" className="pt-1 text-[12px] text-[var(--warning)]">
                      {error}
                    </p>
                  )}
                </div>
              );
            const selected = i === selectedIndex;
            const label = c.kind === "none" ? "No value" : c.kind === "add" ? ADD : c.value;
            return (
              <button
                key={c.kind === "value" ? `v:${c.value}` : c.kind}
                ref={(el) => {
                  items.current[i] = el;
                }}
                type="button"
                role={c.kind === "add" ? "menuitem" : "option"}
                aria-selected={c.kind === "add" ? undefined : selected}
                onClick={() => {
                  if (c.kind === "add") setAdding(true);
                  else pick(c.kind === "none" ? null : c.value);
                }}
                className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[13px] leading-[1.4] text-[var(--text-primary)] outline-none hover:bg-[var(--surface-subtle)] focus-visible:bg-[var(--surface-subtle)] ${
                  c.kind === "none" ? "text-[var(--text-muted)]" : ""
                } ${c.kind === "add" ? "mt-0.5 border-t border-[var(--line-subtler)] pt-1.5" : ""}`}
              >
                <span className="min-w-0 flex-1 truncate">{label}</span>
                {c.kind === "value" && c.stray && (
                  <span className="shrink-0 text-[12px] text-[var(--warning)]">not in list</span>
                )}
                {selected && (
                  <HugeiconsIcon icon={Tick02Icon} size={14} color="currentColor" strokeWidth={2} />
                )}
              </button>
            );
          })}
        </AnchoredPopover>
      )}
    </>
  );
}

interface PropertyEnumSelectProps extends Pick<
  EnumSelectProps,
  "value" | "onSelect" | "defaultOpen" | "onDismiss" | "className"
> {
  /** The property name: its values and "Add value..." come from the property type store. */
  name: string;
}

/** `EnumSelect` wired to the property's recorded type: the properties panel and the Bases table
 *  cell editor both render this one component. */
export function PropertyEnumSelect({ name, ...rest }: PropertyEnumSelectProps) {
  const values = usePropertyTypesStore((s) => s.byKey[typeKey(name)]?.values) ?? NO_VALUES;
  const addEnumValue = usePropertyTypesStore((s) => s.addEnumValue);
  return (
    <EnumSelect
      {...rest}
      values={values}
      ariaLabel={`${name} value`}
      onAdd={(v) => addEnumValue(name, v)}
    />
  );
}
