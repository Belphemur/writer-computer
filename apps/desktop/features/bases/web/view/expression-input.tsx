import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  applyCandidate,
  complete,
  signatureHelp,
  type Candidate,
  type CompletionEnv,
} from "../lib/completion";
import type { VaultProperty } from "../lib/types";
import { getPopupLayer, trackPopup } from "@/lib/popup-layer";
import { rectOf } from "@/lib/popup-position";
import { FIELD } from "./toolbar-menu";
import { useFunctionRegistry } from "./use-function-registry";

interface Props {
  value: string;
  onChange: (value: string) => void;
  /** Accessible name of the field. */
  label: string;
  /** Vault properties offered by name (from `index_properties`). */
  vault: readonly VaultProperty[];
  /** Formulas of the document being edited (name to expression). */
  formulas: Readonly<Record<string, string>>;
  multiline?: boolean;
  placeholder?: string;
  className?: string;
  onBlur?: () => void;
  /** Receives every key the completion list did not handle (Enter to commit, for instance). */
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
}

/** Marks the popup so a surrounding menu does not treat a click on it as an outside click. */
export const COMPLETION_POPUP_ATTR = "data-completion-popup";

function Option({
  candidate,
  id,
  active,
  onPick,
}: {
  candidate: Candidate;
  id: string;
  active: boolean;
  onPick: (c: Candidate) => void;
}) {
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      data-completion-kind={candidate.kind}
      ref={(el) => {
        if (active) el?.scrollIntoView?.({ block: "nearest" });
      }}
      onClick={() => onPick(candidate)}
      className={`flex cursor-pointer flex-col gap-0.5 rounded-md px-2 py-1 ${
        active ? "bg-[var(--surface-selected)]" : "hover:bg-[var(--item-hover-bg)]"
      }`}
    >
      <span className="flex items-baseline justify-between gap-3">
        <span className="font-mono text-[12px] text-text-primary">{candidate.label}</span>
        <span className="truncate font-mono text-[11px] text-text-muted">{candidate.detail}</span>
      </span>
      {candidate.doc ? (
        <span className="truncate text-[11px] text-text-secondary">{candidate.doc}</span>
      ) : null}
    </div>
  );
}

/**
 * A text field for a Bases expression with a completion list: functions and methods (filtered by
 * the type of what is before the dot) with their signature and a line of documentation,
 * namespaces, vault properties, formulas and keywords, plus signature help for the argument being
 * typed. ARIA combobox and listbox; Arrow keys move, Tab and Enter insert, Escape closes,
 * Ctrl+Space (or Alt+Down) opens it without a prefix. The list lives in the host popup layer and
 * is placed by `trackPopup`, so it flips above or below and never clips. The candidates and the
 * caret logic are `lib/bases/completion.ts`.
 */
export function ExpressionInput({
  value,
  onChange,
  label,
  vault,
  formulas,
  multiline,
  placeholder,
  className,
  onBlur,
  onKeyDown,
}: Props) {
  const listId = useId();
  const fieldRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const pendingCaret = useRef<number | null>(null);
  const [caret, setCaret] = useState(value.length);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [forced, setForced] = useState(false);
  const [active, setActive] = useState(0);
  const { functions, error } = useFunctionRegistry();

  const env = useMemo<CompletionEnv>(
    () => ({ functions, properties: vault, formulas }),
    [functions, vault, formulas],
  );
  const shown = focused && !dismissed;
  const result = useMemo(
    () => (shown ? complete(value, caret, env, { force: forced }) : null),
    [shown, value, caret, env, forced],
  );
  const candidates = result?.candidates ?? [];
  const help = useMemo(
    () => (shown ? signatureHelp(value, caret, env) : null),
    [shown, value, caret, env],
  );
  const visible = candidates.length > 0 || help !== null;
  const activeIndex = Math.min(active, Math.max(0, candidates.length - 1));
  const optionId = (i: number) => `${listId}-o${i}`;

  // After inserting, put the caret where the candidate says once the new value is rendered.
  useLayoutEffect(() => {
    const el = fieldRef.current;
    if (pendingCaret.current === null || !el) return;
    el.setSelectionRange(pendingCaret.current, pendingCaret.current);
    pendingCaret.current = null;
  }, [value]);

  // Stable, so the placement tracker is created once per popup, not on every keystroke.
  const placePopup = useCallback((el: HTMLDivElement | null) => {
    const field = fieldRef.current;
    if (!el || !field) return;
    const tracked = trackPopup(el, () => rectOf(field.getBoundingClientRect()), {
      preferred: "below",
    });
    el.style.width = `${Math.max(240, Math.round(field.getBoundingClientRect().width))}px`;
    tracked.update();
    return () => tracked.dispose();
  }, []);

  const sync = (el: HTMLInputElement | HTMLTextAreaElement) => {
    setCaret(el.selectionStart ?? el.value.length);
  };

  const pick = (c: Candidate) => {
    const next = applyCandidate(value, c);
    setActive(0);
    setDismissed(false);
    setForced(false);
    if (next.text === value) {
      fieldRef.current?.setSelectionRange(next.caret, next.caret);
    } else pendingCaret.current = next.caret;
    setCaret(next.caret);
    onChange(next.text);
    fieldRef.current?.focus();
    // A namespace inserts `file.`: keep going with its members.
    if (c.retrigger) setForced(true);
  };

  const handleKey = (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const open = (e.ctrlKey && e.key === " ") || (e.altKey && e.key === "ArrowDown");
    if (open) {
      e.preventDefault();
      setDismissed(false);
      setForced(true);
      return;
    }
    if (shown && candidates.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setActive((activeIndex + step + candidates.length) % candidates.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) {
          onKeyDown?.(e);
          return;
        }
        e.preventDefault();
        pick(candidates[activeIndex]!);
        return;
      }
    }
    if (e.key === "Escape" && visible) {
      // Close the list only; a surrounding menu stays open.
      e.preventDefault();
      e.stopPropagation();
      setDismissed(true);
      setForced(false);
      return;
    }
    onKeyDown?.(e);
  };

  const common = {
    "aria-label": label,
    role: "combobox" as const,
    "aria-autocomplete": "list" as const,
    "aria-haspopup": "listbox" as const,
    "aria-expanded": visible,
    "aria-controls": visible ? listId : undefined,
    "aria-activedescendant": visible && candidates.length > 0 ? optionId(activeIndex) : undefined,
    spellCheck: false,
    autoComplete: "off",
    value,
    placeholder,
    className: `${FIELD} w-full font-mono ${className ?? ""}`,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setDismissed(false);
      setForced(false);
      setActive(0);
      sync(e.currentTarget);
      onChange(e.target.value);
    },
    onSelect: (e: React.SyntheticEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      sync(e.currentTarget),
    onKeyDown: handleKey,
    onFocus: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      sync(e.currentTarget);
      setFocused(true);
    },
    onBlur: () => {
      setFocused(false);
      setDismissed(false);
      setForced(false);
      onBlur?.();
    },
  };

  const groups = [...new Set(candidates.map((c) => c.group))];

  return (
    <div className="relative min-w-0 flex-1">
      {multiline ? (
        <textarea
          ref={(el) => {
            fieldRef.current = el;
          }}
          rows={2}
          {...common}
        />
      ) : (
        <input
          ref={(el) => {
            fieldRef.current = el;
          }}
          type="text"
          {...common}
        />
      )}
      {error ? (
        <div role="alert" data-completion-error className="mt-0.5 text-[11px] text-[var(--danger)]">
          Function suggestions are unavailable: {error}
        </div>
      ) : null}
      {visible
        ? createPortal(
            <div
              {...{ [COMPLETION_POPUP_ATTR]: "" }}
              ref={placePopup}
              // Keep focus in the field when the list is clicked.
              onMouseDown={(e) => e.preventDefault()}
              className="rounded-lg border border-border bg-surface-primary p-1 text-[13px] text-text-primary shadow-lg"
              style={{ position: "fixed", zIndex: 1 }}
            >
              {help ? (
                <div
                  role="status"
                  data-signature-help
                  className="mb-1 border-b border-[var(--line-subtler)] px-2 pb-1"
                >
                  <div className="font-mono text-[12px] text-text-secondary">
                    {help.segments.map((s, i) =>
                      s.active ? (
                        <strong key={i} data-active-param className="text-text-primary underline">
                          {s.text}
                        </strong>
                      ) : (
                        <span key={i}>{s.text}</span>
                      ),
                    )}
                  </div>
                  <div className="text-[11px] text-text-muted">{help.doc}</div>
                </div>
              ) : null}
              {candidates.length > 0 ? (
                <div role="listbox" id={listId} aria-label={`${label} suggestions`}>
                  {groups.map((g) => (
                    <div key={g} role="group" aria-label={g}>
                      <div
                        aria-hidden="true"
                        className="px-2 pb-0.5 pt-1 text-[10px] font-medium uppercase tracking-wide text-text-muted"
                      >
                        {g}
                      </div>
                      {candidates.map((c, i) =>
                        c.group === g ? (
                          <Option
                            key={c.id}
                            candidate={c}
                            id={optionId(i)}
                            active={i === activeIndex}
                            onPick={pick}
                          />
                        ) : null,
                      )}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>,
            getPopupLayer(),
          )
        : null}
    </div>
  );
}
