import { useEffect, useMemo, useState } from "react";
import { indexProperties } from "@/lib/bases/ipc";
import { propertyChoices } from "@/lib/bases/property-choices";
import type { BaseDocument, VaultProperty } from "@/lib/bases/types";
import { errorMessage } from "./use-base-query";
import { FIELD } from "./toolbar-menu";

/** Vault properties from the index, fetched when a menu that needs them opens. */
export function useVaultProperties(): { properties: VaultProperty[]; error: string | null } {
  const [state, setState] = useState<{ properties: VaultProperty[]; error: string | null }>({
    properties: [],
    error: null,
  });
  useEffect(() => {
    let live = true;
    indexProperties().then(
      (properties) => live && setState({ properties, error: null }),
      (e) => live && setState({ properties: [], error: errorMessage(e) }),
    );
    return () => {
      live = false;
    };
  }, []);
  return state;
}

interface Props {
  value: string;
  document: Pick<BaseDocument, "formulas" | "properties">;
  vault: readonly VaultProperty[];
  /** Ids to leave out (already used). */
  exclude?: ReadonlySet<string>;
  /** Text of the empty option (`""`); no empty option when omitted. */
  none?: string;
  label: string;
  onChange: (id: string) => void;
}

/** A `<select>` of property ids; the current value stays selectable even when unknown. */
export function PropertySelect({ value, document, vault, exclude, none, label, onChange }: Props) {
  const choices = useMemo(() => {
    const all = propertyChoices(vault, document).filter(
      (c) => !exclude?.has(c.id) || c.id === value,
    );
    if (value !== "" && !all.some((c) => c.id === value)) all.unshift({ id: value, label: value });
    return all;
  }, [vault, document, exclude, value]);
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={FIELD}
    >
      {none !== undefined ? <option value="">{none}</option> : null}
      {choices.map((c) => (
        <option key={c.id} value={c.id}>
          {c.label}
        </option>
      ))}
    </select>
  );
}
