import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { IconGlyph } from "@/components/icon-picker/icon-glyph";
import { useLinkIcon } from "@/lib/file-icons";
import { linkHandlers } from "@/lib/link-activation";
import * as tauri from "@/lib/tauri";
import {
  parseWikiLinkValue,
  wikiLinkInner,
  WIKI_SUGGEST_TRIGGER,
  wikiSuggestions,
  type WikiSuggestion,
} from "@/lib/wiki-links";
import { AnchoredPopover } from "./anchored-popover";
import { openPropertyWikilink } from "./property-links";

// A `[[wikilink]]` property value as a clickable link, and the `[[` note-name autocomplete for
// the property inputs. Resolution is the vault resolver's (`resolve_wiki_link`, by file name);
// the suggestions are the editor's (`wikiSuggestions`, `lib/wiki-links.ts`).

const RESOLVE_TTL_MS = 5_000;
const resolved = new Map<string, { at: number; found: Promise<boolean> }>();

function checkTarget(path: string): Promise<boolean> {
  const hit = resolved.get(path);
  if (hit && Date.now() - hit.at < RESOLVE_TTL_MS) return hit.found;
  const found = tauri
    .resolveWikiLinkTarget(path, null)
    .then((p) => p !== null)
    .catch(() => true); // a failing resolver is not "missing": never style it as broken
  resolved.set(path, { at: Date.now(), found });
  return found;
}

/** Whether the link's note exists: null while unknown. `[[#Heading]]` links to the note itself. */
function useLinkResolves(value: string): boolean | null {
  const path = parseWikiLinkValue(value).path;
  const [state, setState] = useState<{ path: string; ok: boolean } | null>(null);
  useEffect(() => {
    if (path === "") return;
    let live = true;
    void checkTarget(path).then((ok) => live && setState({ path, ok }));
    return () => {
      live = false;
    };
  }, [path]);
  if (path === "") return true;
  return state?.path === path ? state.ok : null;
}

/** The link text of `[[Note|Alias]]`: its alias, else the note (and `> heading`). */
export function wikilinkLabel(value: string): string {
  const link = parseWikiLinkValue(value);
  if (link.alias || !link.path || !link.fragment) return link.displayText;
  return `${link.path} > ${link.fragment}`;
}

/** A wikilink value as a button that opens the note; dimmed with a dotted underline when the note
 *  does not exist. */
export function WikiLinkButton({ value }: { value: string }) {
  const ok = useLinkResolves(value);
  const icon = useLinkIcon(wikiLinkInner(value));
  return (
    <button
      type="button"
      {...linkHandlers({
        kind: "custom",
        open: (intent) => openPropertyWikilink(value, intent),
      })}
      onMouseDown={(e) => e.preventDefault()}
      title={ok === false ? `${value} (note not found)` : value}
      data-wikilink
      data-unresolved={ok === false ? "" : undefined}
      className={`min-w-0 truncate text-left text-[13px] leading-[1.4] underline-offset-2 hover:underline ${
        ok === false
          ? "text-[var(--text-muted)] underline decoration-dotted"
          : "text-[var(--accent)]"
      }`}
    >
      {icon ? (
        <IconGlyph
          value={icon.icon}
          color={icon.color}
          size={13}
          className="mr-1 align-[-0.15em]"
        />
      ) : null}
      {wikilinkLabel(value)}
    </button>
  );
}

interface Open {
  el: HTMLInputElement;
  from: number;
  to: number;
  items: WikiSuggestion[];
  active: number;
}

/** `[[` autocomplete for an uncontrolled text input: wire `onInput` and `onKeyDown` (which
 *  returns true when it handled the key) into the input and render `menu` next to it. */
export function useWikiSuggest(): {
  onInput: (e: React.FormEvent<HTMLInputElement>) => void;
  onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => boolean;
  menu: ReactNode;
} {
  const [open, setOpen] = useState<Open | null>(null);
  const anchor = useRef<HTMLInputElement | null>(null);
  const seq = useRef(0);

  const accept = (o: Open, item: WikiSuggestion) => {
    const after = o.el.value.slice(o.to, o.to + 2) === "]]" ? o.to + 2 : o.to;
    o.el.setRangeText(`${item.insertText}]]`, o.from, after, "end");
    setOpen(null);
  };

  const onInput = (e: React.FormEvent<HTMLInputElement>) => {
    const el = e.currentTarget;
    const caret = el.selectionStart ?? el.value.length;
    const m = WIKI_SUGGEST_TRIGGER.exec(el.value.slice(0, caret));
    const id = ++seq.current;
    if (!m || m[1].trim() === "") {
      setOpen(null);
      return;
    }
    const query = m[1];
    void wikiSuggestions(query, tauri.fuzzySearch)
      .then((items) => {
        if (id !== seq.current) return;
        anchor.current = el;
        setOpen(
          items.length === 0
            ? null
            : { el, from: caret - query.length, to: caret, items, active: 0 },
        );
      })
      .catch(() => id === seq.current && setOpen(null));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): boolean => {
    if (!open) return false;
    const n = open.items.length;
    if (e.key === "ArrowDown") setOpen({ ...open, active: (open.active + 1) % n });
    else if (e.key === "ArrowUp") setOpen({ ...open, active: (open.active + n - 1) % n });
    else if (e.key === "Enter" || e.key === "Tab") accept(open, open.items[open.active]);
    else if (e.key === "Escape") setOpen(null);
    else return false;
    e.preventDefault();
    e.stopPropagation();
    return true;
  };

  const menu = open && (
    <AnchoredPopover
      anchorRef={anchor}
      width={288}
      role="listbox"
      label="Notes"
      onDismiss={() => setOpen(null)}
    >
      {open.items.map((item, i) => (
        <button
          key={`${i}:${item.insertText}`}
          type="button"
          role="option"
          aria-selected={i === open.active}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => accept(open, item)}
          className={`flex w-full items-baseline gap-2 rounded px-2 py-1 text-left text-[13px] leading-[1.4] text-[var(--text-primary)] ${
            i === open.active ? "bg-[var(--surface-subtle)]" : "hover:bg-[var(--surface-subtle)]"
          }`}
        >
          <span className="min-w-0 truncate">{item.label}</span>
          {item.detail && (
            <span className="min-w-0 truncate text-[12px] text-[var(--text-muted)]">
              {item.detail}
            </span>
          )}
        </button>
      ))}
    </AnchoredPopover>
  );

  return { onInput, onKeyDown, menu };
}
