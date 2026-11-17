import { create } from "zustand";
import { propertyTypes, propertyTypeSet } from "@/lib/property-types-ipc";
import { typeKey, type PropertyType, type PropertyTypeInfo } from "@/lib/property-types";

// The frontend's one view of the vault's property types (record from Rust, else inferred). The
// properties panel, the add-property suggestions and the plugin host's `metadataTypeManager` all
// read it; writes go through `setType` (Writer's own record, never `.obsidian`).
const TTL_MS = 30_000;

interface PropertyTypesState {
  byKey: Record<string, PropertyTypeInfo>;
  loadedAt: number;
  /** Fetch the vault's property types; skipped while a fetch is fresh unless `force`. */
  load: (force?: boolean) => Promise<void>;
  /** Record `type` for `name` vault-wide; rolls the local state back when the write fails.
   *  `values` is an enum's whole list; without it the backend seeds a new enum from the vault's
   *  existing values (and keeps a recorded enum's list). */
  setType: (name: string, type: PropertyType, values?: string[]) => Promise<void>;
  /** Append `value` to an enum property's list (the one write path for "Add value"); a value
   *  already in the list is a no-op. Resolves to the stored value (trimmed). */
  addEnumValue: (name: string, value: string) => Promise<string>;
}

let inflight: Promise<void> | null = null;
// Only the newest fetch may write the state: an older one started before a `setType` would
// otherwise overwrite it with the record as it was.
let latest = 0;

export const usePropertyTypesStore = create<PropertyTypesState>((set, get) => ({
  byKey: {},
  loadedAt: 0,
  load: (force = false) => {
    if (!force) {
      if (inflight) return inflight;
      if (Date.now() - get().loadedAt < TTL_MS) return Promise.resolve();
    }
    const mine = ++latest;
    const run = Promise.resolve()
      .then(propertyTypes)
      .then((infos) => {
        if (mine !== latest) return;
        set({
          byKey: Object.fromEntries(infos.map((i) => [typeKey(i.key), i])),
          loadedAt: Date.now(),
        });
      });
    const tracked = run.finally(() => {
      if (inflight === tracked) inflight = null;
    });
    inflight = tracked;
    return tracked;
  },
  setType: async (name, type, values) => {
    const key = typeKey(name);
    const before = get().byKey[key];
    const next: PropertyTypeInfo = {
      key: before?.key ?? name.trim(),
      count: before?.count ?? 0,
      types: before?.types ?? {},
      type,
      source: "writer",
      mismatched: 0,
      // only the Writer-only types differ from `type`; the refetch below replaces this guess
      obsidianType:
        type === "relationships"
          ? (before?.obsidianType ?? "text")
          : type === "enum"
            ? "text"
            : type,
      // an unseeded enum shows its recorded list (if any) until the refetch brings the seed
      values: type === "enum" ? (values ?? (before?.type === "enum" ? before.values : [])) : [],
    };
    set((s) => ({ byKey: { ...s.byKey, [key]: next } }));
    try {
      await propertyTypeSet(name, type, ...(values ? [values] : []));
    } catch (e) {
      set((s) => {
        const byKey = { ...s.byKey };
        if (before) byKey[key] = before;
        else delete byKey[key];
        return { byKey };
      });
      throw e;
    }
    // The mismatch count depends on the new type; the observed values do not change.
    void get()
      .load(true)
      .catch(() => {});
  },
  addEnumValue: async (name, value) => {
    const v = value.trim();
    const info = get().byKey[typeKey(name)];
    const current = info?.type === "enum" ? info.values : [];
    if (v === "" || current.includes(v)) return v;
    await get().setType(name, "enum", [...current, v]);
    return v;
  },
}));

/** The recorded or vault-inferred info of a property name, if the vault knows it. */
export function propertyTypeInfo(name: string): PropertyTypeInfo | undefined {
  return usePropertyTypesStore.getState().byKey[typeKey(name)];
}
