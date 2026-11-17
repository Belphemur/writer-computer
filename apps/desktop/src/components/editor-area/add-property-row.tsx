import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { PROPERTY_TYPES, typeKey, type PropertyType } from "@/lib/property-types";
import { usePropertyTypesStore } from "@/stores/property-types-store";
import { AnchoredPopover } from "./anchored-popover";
import { PropertyTypeControl } from "./property-type-control";

const BUTTON =
  "rounded px-1.5 py-0.5 text-[12px] leading-[1.3] text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-border)]";
const SUGGESTIONS = 8;

interface AddRowProps {
  /** Returns whether the property was added. `picked` is true when the type was chosen here. */
  onAdd: (key: string, type: PropertyType, picked: boolean) => boolean;
  onClose?: () => void;
  autoFocus: boolean;
}

function focusOnMount(el: HTMLInputElement | null) {
  el?.focus();
}

/** Name (with the vault's known names and their types as suggestions) and type of a new property.
 *  A known name defaults to its recorded type; the type menu picks one up front. */
export function AddPropertyRow({ onAdd, onClose, autoFocus }: AddRowProps) {
  const byKey = usePropertyTypesStore((s) => s.byKey);
  const load = usePropertyTypesStore((s) => s.load);
  const input = useRef<HTMLInputElement | null>(null);
  const [key, setKey] = useState("");
  const [picked, setPicked] = useState<PropertyType | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);

  useEffect(() => {
    void load().catch(() => {}); // no index yet / no backend: just no suggestions
  }, [load]);

  const name = key.trim();
  const known = byKey[typeKey(name)];
  const type = picked ?? known?.type ?? "text";
  const suggestions = useMemo(() => {
    const q = name.toLowerCase();
    return Object.values(byKey)
      .filter((p) => p.key.toLowerCase() !== q && (q === "" || p.key.toLowerCase().includes(q)))
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
      .slice(0, SUGGESTIONS);
  }, [byKey, name]);
  const showList = open && suggestions.length > 0 && name !== "";

  const pick = (k: string) => {
    setKey(k);
    setPicked(null);
    setOpen(false);
    setActive(-1);
    input.current?.focus();
  };
  const submit = () => {
    if (name === "") return;
    if (onAdd(name, type, picked !== null)) {
      setKey("");
      setPicked(null);
      onClose?.();
    }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (showList && e.key === "ArrowDown") {
      e.preventDefault();
      setActive((active + 1) % suggestions.length);
    } else if (showList && e.key === "ArrowUp") {
      e.preventDefault();
      setActive((active - 1 + suggestions.length) % suggestions.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (showList && active >= 0) pick(suggestions[active].key);
      else submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (showList) {
        setOpen(false);
        return;
      }
      setKey("");
      onClose?.();
    }
  };
  return (
    <div className="flex items-center gap-2 pt-1">
      <PropertyTypeControl name="New property" type={type} fits onChange={(t) => setPicked(t)} />
      <input
        ref={(el) => {
          input.current = el;
          if (autoFocus) focusOnMount(el);
        }}
        type="text"
        role="combobox"
        aria-expanded={showList}
        aria-autocomplete="list"
        aria-label="New property name"
        placeholder="Property name"
        value={key}
        spellCheck={false}
        onChange={(e) => {
          setKey(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onKeyDown={onKeyDown}
        className="min-w-0 flex-1 rounded bg-transparent px-1 -mx-1 text-[13px] leading-[1.4] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] placeholder:opacity-70 focus-visible:bg-[var(--surface-subtle)]"
      />
      {showList && (
        <AnchoredPopover
          anchorRef={input}
          width={288}
          role="listbox"
          label="Existing properties"
          onDismiss={() => setOpen(false)}
        >
          {suggestions.map((p, i) => (
            <button
              key={p.key}
              type="button"
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(p.key)}
              className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[13px] leading-[1.4] text-[var(--text-primary)] ${
                i === active ? "bg-[var(--surface-subtle)]" : "hover:bg-[var(--surface-subtle)]"
              }`}
            >
              <HugeiconsIcon
                icon={PROPERTY_TYPES[p.type].icon}
                size={14}
                color="currentColor"
                strokeWidth={1.75}
                className="shrink-0 text-[var(--text-muted)]"
              />
              <span className="min-w-0 flex-1 truncate">{p.key}</span>
              <span className="shrink-0 text-[12px] text-[var(--text-muted)]">
                {PROPERTY_TYPES[p.type].label}
              </span>
            </button>
          ))}
        </AnchoredPopover>
      )}
      <button type="button" onClick={submit} disabled={name === ""} className={BUTTON}>
        Add
      </button>
    </div>
  );
}
