// Typed `invoke` wrappers for the property type record (`commands/index.rs`). Tests mock this
// module; the store and nothing else reaches the backend through it.
import { invoke } from "@tauri-apps/api/core";
import type { PropertyType, PropertyTypeInfo } from "./property-types";

/** Every vault property with its effective type, source and mismatch count. */
export function propertyTypes(): Promise<PropertyTypeInfo[]> {
  return invoke("property_types");
}

/** Record a property's type vault-wide in `.writer/property-types.json` (never `.obsidian`).
 *  `values` is an enum's whole ordered list; omitted, a new enum is seeded from the values the
 *  vault already holds under that name. */
export function propertyTypeSet(name: string, ty: PropertyType, values?: string[]): Promise<void> {
  return invoke("property_type_set", { name, ty, values: values ?? null });
}
