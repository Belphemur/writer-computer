// Records one key combination for a command: press keys (a lone modifier is ignored), Enter saves,
// Esc cancels, Backspace clears what was pressed. A key that is reserved or needs a modifier is
// refused with a one-line reason; a key another command has offers Reassign or Cancel. The app's
// own shortcuts stand down while this is open (`beginKeyRecording`).
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { commandLabel } from "@/components/command-palette/commands";
import { eventToChord } from "@/lib/keybindings/chord";
import { beginKeyRecording } from "@/lib/keybindings/recording";
import { keybindings } from "@/lib/keybindings/registry";
import { detectPlatform } from "@/lib/platform";
import { checkChord, recordKey, REFUSAL_TEXT, type RecordOptions } from "./actions";

const BUTTON =
  "rounded-md px-2 py-0.5 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--surface-subtle-strong)]";

export function KeyRecorder({
  id,
  mode,
  onDone,
}: {
  id: string;
  mode: RecordOptions["mode"];
  onDone: () => void;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const check = pending ? checkChord(id, pending) : null;

  useEffect(() => {
    box.current?.focus();
    return beginKeyRecording();
  }, []);

  async function save(reassign: boolean) {
    if (!pending) return;
    try {
      await recordKey(id, pending, { mode, reassign });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.target !== e.currentTarget) {
      // A button inside (Reassign, Cancel) handles its own keys; Esc still cancels.
      if (e.key === "Escape") {
        e.preventDefault();
        onDone();
      }
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const plain = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
    if (plain && e.key === "Escape") return onDone();
    if (plain && e.key === "Enter") return void (check?.kind === "ok" && save(false));
    if (plain && e.key === "Backspace") {
      setPending(null);
      setError(null);
      return;
    }
    const chord = eventToChord(e, detectPlatform());
    if (!chord) return;
    setPending(chord);
    setError(null);
  }

  const other = check?.kind === "conflict" ? check.id : null;
  const note =
    error ??
    (check?.kind === "refused" ? REFUSAL_TEXT[check.reason] : null) ??
    (other
      ? `Used by ${commandLabel(other) ?? keybindings.get(other)?.description ?? other}`
      : null);

  return (
    <div
      ref={box}
      role="group"
      aria-label="Record a key"
      tabIndex={0}
      data-key-recorder={id}
      onKeyDown={onKeyDown}
      className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-[var(--line-subtle)] px-2 py-1 text-[12px] outline-none focus:border-[var(--text-muted)]"
    >
      <span data-recorder-keys className="text-[var(--text-primary)]">
        {pending ? keybindings.format(pending) : "Press keys"}
      </span>
      {note && (
        <span role="status" data-recorder-note className="text-[var(--text-muted)]">
          {note}
        </span>
      )}
      {other ? (
        <>
          <button type="button" autoFocus className={BUTTON} onClick={() => void save(true)}>
            Reassign
          </button>
          <button type="button" className={BUTTON} onClick={onDone}>
            Cancel
          </button>
        </>
      ) : (
        <span className="text-[var(--text-muted)]">Enter saves, Esc cancels</span>
      )}
    </div>
  );
}
