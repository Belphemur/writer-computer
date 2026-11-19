import { create } from "zustand";
import { propertyPinSet, propertyTypes, propertyTypeSet } from "@/lib/property-types-ipc";
import { typeKey, type PropertyType, type PropertyTypeInfo } from "@/lib/property-types";
import { onPropertyTypesChanged } from "@/lib/property-types-events";

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
  setType: (
    name: string,
    type: PropertyType,
    values?: string[],
    icons?: Record<string, string>,
  ) => Promise<void>;
  /** Pin or unpin `name` vault-wide (the one write path of pins); rolls the local state back when
   *  the write fails. A pin takes the next place, an unpin closes the gap, as the backend does. */
  setPinned: (name: string, pinned: boolean) => Promise<void>;
  /** Set (or with `null` remove) the icon of one value of an enum property through `setType`, the
   *  one write path; the values and the other icons stay. */
  setEnumIcon: (name: string, value: string, icon: string | null) => Promise<void>;
  /** Append `value` to an enum property's list (the one write path for "Add value"); a value
   *  already in the list is a no-op. Resolves to the stored value (trimmed). */
  addEnumValue: (name: string, value: string) => Promise<string>;
}

let inflight: Promise<void> | null = null;
let listening = false;

/** Reload when the backend changed the record itself (an enum gained the values notes hold). Once. */
function followBackendChanges() {
  if (listening) return;
  listening = true;
  onPropertyTypesChanged(() => {
    void usePropertyTypesStore
      .getState()
      .load(true)
      .catch(() => {});
  }).catch(() => {
    listening = false;
  });
}
// Only the newest fetch may write the state: an older one started before a `setType` would
// otherwise overwrite it with the record as it was.
let latest = 0;

export const usePropertyTypesStore = create<PropertyTypesState>((set, get) => ({
  byKey: {},
  loadedAt: 0,
  load: (force = false) => {
    followBackendChanges();
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
  setType: async (name, type, values, icons) => {
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
        type === "relationships" || type === "url"
          ? (before?.obsidianType ?? "text")
          : type === "enum" || type === "object"
            ? "text"
            : type,
      // an unseeded enum shows its recorded list (if any) until the refetch brings the seed
      values: type === "enum" ? (values ?? (before?.type === "enum" ? before.values : [])) : [],
      pinned: before?.pinned ?? null,
      icons:
        type === "enum"
          ? Object.fromEntries(
              Object.entries(icons ?? (before?.type === "enum" ? (before.icons ?? {}) : {})).filter(
                ([v]) => (values ?? before?.values ?? []).includes(v),
              ),
            )
          : {},
    };
    set((s) => ({ byKey: { ...s.byKey, [key]: next } }));
    try {
      // trailing arguments are left out when absent (the backend reads them as "keep")
      const args: Parameters<typeof propertyTypeSet> = icons
        ? [name, type, values, icons]
        : values
          ? [name, type, values]
          : [name, type];
      await propertyTypeSet(...args);
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
  setPinned: async (name, pinned) => {
    const key = typeKey(name);
    const before = get().byKey;
    const info = before[key];
    if (info && (info.pinned != null) !== pinned) {
      const places = Object.values(before).flatMap((i) => (i.pinned == null ? [] : [i.pinned]));
      const gone = info.pinned;
      set({
        byKey: Object.fromEntries(
          Object.entries(before).map(([k, i]) => [
            k,
            k === key
              ? { ...i, pinned: pinned ? Math.max(-1, ...places) + 1 : null }
              : !pinned && gone != null && i.pinned != null && i.pinned > gone
                ? { ...i, pinned: i.pinned - 1 }
                : i,
          ]),
        ),
      });
    }
    try {
      await propertyPinSet(name, pinned);
    } catch (e) {
      set({ byKey: before });
      throw e;
    }
    // an untyped name had no entry to update: the refetch brings it
    void get()
      .load(true)
      .catch(() => {});
  },
  setEnumIcon: async (name, value, icon) => {
    const info = get().byKey[typeKey(name)];
    if (info?.type !== "enum" || !info.values.includes(value)) return;
    const icons = { ...info.icons }; // (an old backend sends none)
    if (icon === null) delete icons[value];
    else icons[value] = icon;
    await get().setType(name, "enum", info.values, icons);
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
