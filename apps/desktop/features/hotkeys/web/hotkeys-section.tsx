// Settings > Hotkeys: every command with its key, grouped by who owns it (Writer, each feature,
// each plugin). Rows are data from the registry (`model.ts`), changes go through `actions.ts`
// (SPECs/hotkeys-spec.md). A thin view: no key rule lives here.
import { useEffect, useReducer, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon, Cancel01Icon, PencilEdit01Icon, Undo02Icon } from "@hugeicons/core-free-icons";
import { commandLabel } from "@/components/command-palette/commands";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { eventToChord, isBindableChord } from "@/lib/keybindings/chord";
import { hotkeyOverrides } from "@/lib/keybindings/overrides";
import { beginKeyRecording } from "@/lib/keybindings/recording";
import { keybindings } from "@/lib/keybindings/registry";
import { detectPlatform } from "@/lib/platform";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { importFromObsidian, removeKey, resetAllKeys, resetKeys } from "./actions";
import { KeyRecorder } from "./key-recorder";
import { buildGroups, filterGroups, type HotkeyRow, type Query } from "./model";

const CARD =
  "overflow-hidden rounded-2xl border border-[var(--line-subtler)] bg-[var(--surface-card)]";
const ICON_BUTTON =
  "inline-flex size-6 shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--surface-subtle-strong)] hover:text-[var(--text-primary)]";
const BUTTON =
  "shrink-0 rounded-lg border border-[var(--line-subtle)] px-3 py-1.5 text-[13px] text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-subtle-strong)] disabled:opacity-50";
/** The text-editing chords the search box leaves to the input (copy, paste, undo...). */
const EDITING = new Set(["Mod+A", "Mod+C", "Mod+V", "Mod+X", "Mod+Z", "Mod+Shift+Z"]);

/** Re-renders when the registry's entries or the user's keys change. */
function useRegistryVersion(): void {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => keybindings.subscribe(bump), []);
  useEffect(() => hotkeyOverrides.onLoaded(bump), []);
}

function Icon({ icon }: { icon: typeof Add01Icon }) {
  return <HugeiconsIcon icon={icon} size={14} color="currentColor" strokeWidth={2} />;
}

function KeyChip({ row, chord, index }: { row: HotkeyRow; chord: string; index: number }) {
  const shown = `${index > 0 ? "+" : ""}${keybindings.format(chord)}`;
  if (!row.rebindable)
    return <kbd className="text-[12px] text-[var(--text-secondary)]">{shown}</kbd>;
  // Backspace or Delete on a focused key removes it, like the x.
  return (
    <span className="group inline-flex items-center gap-0.5 rounded-md bg-[var(--surface-subtle)] px-1.5 py-0.5">
      <kbd
        tabIndex={0}
        data-key-chip={chord}
        className="text-[12px] text-[var(--text-secondary)] outline-none"
        onKeyDown={(e) => {
          if (e.key !== "Backspace" && e.key !== "Delete") return;
          e.preventDefault();
          void removeKey(row.id, chord);
        }}
      >
        {shown}
      </kbd>
      <button
        type="button"
        aria-label={`Remove ${keybindings.format(chord)}`}
        className="opacity-0 group-hover:opacity-100 focus:opacity-100"
        onClick={() => void removeKey(row.id, chord)}
      >
        <Icon icon={Cancel01Icon} />
      </button>
    </span>
  );
}

function Row({ row }: { row: HotkeyRow }) {
  const [recording, setRecording] = useState<"replace" | "add" | null>(null);
  return (
    <div
      data-hotkey-row={row.id}
      className="flex min-h-10 items-center gap-3 border-t border-[var(--line-subtler)] px-4 py-1.5 first:border-t-0"
    >
      <div className="min-w-0 flex-1 truncate text-[13px] text-[var(--text-primary)]">
        {row.label}
      </div>
      {recording ? (
        <KeyRecorder id={row.id} mode={recording} onDone={() => setRecording(null)} />
      ) : (
        <>
          <div className="flex shrink-0 items-center gap-1.5">
            {row.chords.length === 0 ? (
              <span className="text-[12px] text-[var(--text-muted)]">—</span>
            ) : (
              row.chords.map((c, i) => <KeyChip key={c} row={row} chord={c} index={i} />)
            )}
            {row.modified && (
              <span data-hotkey-modified className="text-[12px] text-[var(--text-muted)]">
                modified
              </span>
            )}
          </div>
          {row.rebindable && (
            <div className="flex shrink-0 items-center gap-0.5">
              {row.chords.length > 0 && (
                <button
                  type="button"
                  aria-label={`Add a key to ${row.label}`}
                  className={ICON_BUTTON}
                  onClick={() => setRecording("add")}
                >
                  <Icon icon={Add01Icon} />
                </button>
              )}
              <button
                type="button"
                aria-label={`Change the key of ${row.label}`}
                className={ICON_BUTTON}
                onClick={() => setRecording("replace")}
              >
                <Icon icon={PencilEdit01Icon} />
              </button>
              {row.modified && (
                <button
                  type="button"
                  aria-label={`Reset ${row.label}`}
                  className={ICON_BUTTON}
                  onClick={() => void resetKeys(row.id)}
                >
                  <Icon icon={Undo02Icon} />
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** The search box: words filter by name; a key combination pressed in it finds its command. */
function SearchBox({ query, onChange }: { query: Query; onChange: (q: Query) => void }) {
  const [stop, setStop] = useState<(() => void) | null>(null);
  useEffect(() => () => stop?.(), [stop]);
  const value = query.kind === "chord" ? keybindings.format(query.chord) : query.text;
  return (
    <input
      type="search"
      data-hotkeys-search
      value={value}
      placeholder="Search commands or press keys"
      aria-label="Search commands or press keys"
      // The app's shortcuts stand down while the box is focused, so a pressed key is searched
      // for, not run.
      onFocus={() => setStop(() => beginKeyRecording())}
      onBlur={() => setStop(null)}
      onChange={(e) => onChange({ kind: "text", text: e.target.value })}
      onKeyDown={(e) => {
        const chord = eventToChord(e, detectPlatform());
        if (chord && isBindableChord(chord) && !EDITING.has(chord)) {
          e.preventDefault();
          onChange({ kind: "chord", chord });
        } else if (query.kind === "chord") {
          if (e.key === "Backspace" || e.key === "Escape") e.preventDefault();
          if (e.key.length === 1 || e.key === "Backspace" || e.key === "Escape")
            onChange({ kind: "text", text: "" });
        }
      }}
      className="h-8 w-72 max-w-full rounded-lg border border-[var(--line-subtle)] bg-transparent px-3 text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--text-muted)]"
    />
  );
}

export function HotkeysSection() {
  useRegistryVersion();
  const hasWorkspace = useWorkspaceStore((s) => s.root !== null);
  const [query, setQuery] = useState<Query>({ kind: "text", text: "" });
  const [status, setStatus] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const groups = filterGroups(buildGroups(keybindings, commandLabel), query);
  const loadError = hotkeyOverrides.loadError;

  async function runImport() {
    try {
      const result = await importFromObsidian();
      setStatus(
        result
          ? `Imported ${result.imported}, skipped ${result.skipped}`
          : "No hotkeys.json in .obsidian",
      );
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <section data-hotkeys className="mb-10">
      <div className="mb-4 flex justify-end">
        <SearchBox query={query} onChange={setQuery} />
      </div>
      {loadError && (
        <p
          role="alert"
          data-hotkeys-load-error
          className="mb-3 text-[13px] text-[var(--text-muted)]"
        >
          Could not read hotkeys.json: {loadError}
        </p>
      )}
      <div className="space-y-5">
        {groups.map((g) => (
          <div key={g.name} data-hotkey-group={g.name}>
            <h3 className="mb-1.5 px-1 text-[12px] font-medium text-[var(--text-muted)]">
              {g.name}
            </h3>
            <div className={CARD}>
              {g.rows.map((r) => (
                <Row key={r.id} row={r} />
              ))}
            </div>
          </div>
        ))}
        {groups.length === 0 && (
          <p data-hotkeys-empty className="px-1 text-[13px] text-[var(--text-muted)]">
            No commands
          </p>
        )}
      </div>
      <div className="mt-5 flex items-center justify-between gap-3">
        <button
          type="button"
          className={BUTTON}
          disabled={!hasWorkspace}
          onClick={() => void runImport()}
        >
          Import from Obsidian
        </button>
        <button type="button" className={BUTTON} onClick={() => setConfirmReset(true)}>
          Reset all
        </button>
      </div>
      {status && (
        <div
          role="status"
          data-hotkeys-status
          className="mt-3 text-[13px] text-[var(--text-muted)]"
        >
          {status}
        </div>
      )}
      {confirmReset && (
        <ConfirmDialog
          title="Reset all hotkeys?"
          confirmLabel="Reset all"
          destructive
          onConfirm={() => resetAllKeys()}
          onClose={() => setConfirmReset(false)}
        >
          Every command goes back to its default key on this computer's OS.
        </ConfirmDialog>
      )}
    </section>
  );
}
