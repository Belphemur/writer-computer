// Typed `invoke` wrappers for the property type record (`commands/index.rs`). Tests mock this
// module; the store and nothing else reaches the backend through it.
import { invoke } from "@tauri-apps/api/core";
import type { PropertyType, PropertyTypeInfo } from "./property-types";

/** Every vault property with its effective type, source and mismatch count. */
export function propertyTypes(): Promise<PropertyTypeInfo[]> {
  return invoke("property_types");
}

/** Record a property's type vault-wide in `.writer/property-types.json` (never `.obsidian`). */
export function propertyTypeSet(name: string, ty: PropertyType): Promise<void> {
  return invoke("property_type_set", { name, ty });
}
