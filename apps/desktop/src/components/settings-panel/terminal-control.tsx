import { useEffect, useState } from "react";
import { listTerminals, type TerminalInfo } from "@/lib/tauri";
import { SelectControl } from "./select-control";
import { StringControl } from "./string-control";

const SYSTEM_DEFAULT = "";
const OTHER = "\u0000other";

const BASE_LABELS = { [SYSTEM_DEFAULT]: "System default", [OTHER]: "Other…" };

/** The option a stored value maps to: blank is the system default, a name in the found list is that
 *  terminal, anything else is "Other". Pure so the mapping is tested without a window. */
export function terminalSelection(value: string, terminals: readonly TerminalInfo[]): string {
  const name = value.trim().toLowerCase();
  if (!name) return SYSTEM_DEFAULT;
  const found = terminals.find((t) => t.names.some((n) => n.toLowerCase() === name));
  return found ? found.id : OTHER;
}

/** Installed terminals plus "System default" and "Other…" (a name or path, as before). The list is
 *  asked for when the control mounts, that is when the settings page opens. */
export function TerminalControl({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void | Promise<void>;
}) {
  const [terminals, setTerminals] = useState<TerminalInfo[] | null>(null);
  const [pickedOther, setPickedOther] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listTerminals().then(
      (found) => {
        if (!cancelled) setTerminals(found);
      },
      () => {
        // Detection is a convenience: without it only the default and "Other…" remain.
        if (!cancelled) setTerminals([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const found = terminals ?? [];
  const selection = pickedOther ? OTHER : terminalSelection(value, found);
  const labels = {
    ...BASE_LABELS,
    ...Object.fromEntries(found.map((t) => [t.id, t.label])),
  };

  function select(next: string) {
    setPickedOther(next === OTHER);
    if (next === OTHER) return;
    void onChange(next);
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <SelectControl
        value={selection}
        options={[SYSTEM_DEFAULT, ...found.map((t) => t.id), OTHER]}
        labels={labels}
        disabled={terminals === null}
        ariaLabel="Default Terminal"
        onChange={select}
        className="w-64"
      />
      {selection === OTHER && (
        <StringControl value={value} placeholder="App name or path" onChange={onChange} />
      )}
    </div>
  );
}
