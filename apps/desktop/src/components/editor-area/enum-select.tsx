import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { IconPicker } from "@/components/icon-picker/icon-picker";
import { IconGlyph } from "@/components/icon-picker/icon-glyph";
import { typeKey } from "@/lib/property-types";
import { usePropertyTypesStore } from "@/stores/property-types-store";
import { AnchoredPopover } from "./anchored-popover";
import { showEditorNotice } from "./editor-notice-store";
import { FIELD } from "./property-chip";

const NO_VALUES: readonly string[] = [];
const NO_ICONS: Readonly<Record<string, string>> = {};
const ADD = "Add value…";

interface EnumSelectProps {
  /** The note's value; `null` or empty is no value. */
  value: string | null;
  /** The type's allowed values, in order. */
  values: readonly string[];
  ariaLabel: string;
  /** A pick; `null` clears the value. */
  onSelect: (value: string | null) => void;
  /** The values' optional icons (`emoji:..` / `icon:..`), shown before the value. */
  icons?: Readonly<Record<string, string>>;
  /** Set (or with `null` remove) a value's icon: each value row gets an icon slot that opens the
   *  picker. Without it the icons are shown but not editable. */
  onIcon?: (value: string, icon: string | null) => void;
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
  icons = NO_ICONS,
  onIcon,
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
  // the value whose icon the picker is choosing, the slot it opened from and its box
  const [picking, setPicking] = useState<string | null>(null);
  const pickerAnchor = useRef<HTMLElement | null>(null);
  const pickerBox = useRef<HTMLDivElement>(null);
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
    setPicking(null);
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
    else if (e.key === "Tab") {
      // Tab walks the rows and their icon slots; it leaves the list from either end
      const all = [...e.currentTarget.querySelectorAll<HTMLElement>("button")];
      const at = all.indexOf(document.activeElement as HTMLElement);
      if (e.shiftKey ? at > 0 : at >= 0 && at < all.length - 1) return;
      close(false);
    } else return;
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
        {current !== null && <IconGlyph value={icons[current]} />}
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
          alsoInside={pickerBox}
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
            const main = (
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
                className={`flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1 text-left text-[13px] leading-[1.4] text-[var(--text-primary)] outline-none hover:bg-[var(--surface-subtle)] focus-visible:bg-[var(--surface-subtle)] ${
                  c.kind === "none" ? "text-[var(--text-muted)]" : ""
                } ${c.kind === "add" ? "mt-0.5 w-full flex-none border-t border-[var(--line-subtler)] pt-1.5" : ""}`}
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
            if (c.kind !== "value" || c.stray) return main;
            const icon = icons[c.value];
            return (
              <div key={`v:${c.value}`} className="group/row flex items-center gap-0.5">
                {onIcon ? (
                  <button
                    type="button"
                    aria-label={`Icon of ${c.value}`}
                    aria-haspopup="dialog"
                    aria-expanded={picking === c.value}
                    onClick={(e) => {
                      pickerAnchor.current = e.currentTarget;
                      setPicking(picking === c.value ? null : c.value);
                    }}
                    className="flex size-6 shrink-0 items-center justify-center rounded text-[var(--text-icon-muted)] hover:bg-[var(--surface-subtle)] hover:text-[var(--text-primary)] focus-visible:bg-[var(--surface-subtle)] focus-visible:outline-none"
                  >
                    {icon ? (
                      <IconGlyph value={icon} size={14} />
                    ) : (
                      <span
                        aria-hidden="true"
                        className="text-[13px] leading-none opacity-0 group-hover/row:opacity-60 group-focus-within/row:opacity-60"
                      >
                        +
                      </span>
                    )}
                  </button>
                ) : (
                  <span className="flex size-6 shrink-0 items-center justify-center">
                    <IconGlyph value={icon} size={14} />
                  </span>
                )}
                {main}
              </div>
            );
          })}
        </AnchoredPopover>
      )}
      {open && picking !== null && onIcon && (
        <AnchoredPopover
          anchorRef={pickerAnchor}
          width={316}
          maxHeight={440}
          bare
          role="group"
          label={`Icon of ${picking}`}
          onDismiss={() => setPicking(null)}
        >
          <div ref={pickerBox}>
            <IconPicker
              label={`Icon of ${picking}`}
              value={icons[picking] ?? null}
              onPick={(v) => {
                onIcon(picking, v);
                setPicking(null);
                pickerAnchor.current?.focus();
              }}
              onRemove={() => {
                onIcon(picking, null);
                setPicking(null);
                pickerAnchor.current?.focus();
              }}
              onClose={() => {
                setPicking(null);
                pickerAnchor.current?.focus();
              }}
            />
          </div>
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
  const icons = usePropertyTypesStore((s) => s.byKey[typeKey(name)]?.icons) ?? NO_ICONS;
  const addEnumValue = usePropertyTypesStore((s) => s.addEnumValue);
  const setEnumIcon = usePropertyTypesStore((s) => s.setEnumIcon);
  return (
    <EnumSelect
      {...rest}
      values={values}
      icons={icons}
      onIcon={(value, icon) =>
        void setEnumIcon(name, value, icon).catch(() => showEditorNotice("Could not save the icon"))
      }
      ariaLabel={`${name} value`}
      onAdd={(v) => addEnumValue(name, v)}
    />
  );
}
