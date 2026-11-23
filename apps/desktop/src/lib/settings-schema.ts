/**
 * Typed registry built from the JSON sources of truth.
 *
 *   - `apps/desktop/shared/settings.schema.json` plus each built-in feature's
 *     `features/<id>/settings.schema.json` fragment
 *       The settings *contract*: keys, types, defaults, labels, descriptions,
 *       and CSS-var bindings. Read by Rust (`include_str!` in config.rs, fragments
 *       through `features::settings_fragments`) and imported here statically so
 *       TypeScript can derive literal types for the core keys.
 *
 *   - `apps/desktop/shared/themes/<slug>/{light,dark}.json`
 *       Default theme *values*. Each preset is a folder with one JSON file
 *       per mode, holding just the primary values. Picked up by glob so
 *       dropping a new folder registers a new preset — no TS edits needed.
 *       The folder slug becomes the display name (kebab-case → Title Case).
 *
 * Splitting contract from values follows the same separation Rust uses: the
 * schema describes how a setting works; presets are just curated bundles of
 * values that map onto those settings.
 */

import schemaFile from "@shared/settings.schema.json";
import { detectPlatform, type Platform } from "./platform";

// ---------- Typed schema (contract) ----------

type RawSchema = typeof schemaFile;

type RawEntry = RawSchema["settings"][number];

/** Map a schema entry's `type` literal to the runtime value type. Settings
 *  with `cssFormat: "px"` are still numbers in the store — formatting only
 *  happens when writing to CSS. */
type ValueOf<T extends RawEntry> = T["type"] extends "boolean"
  ? boolean
  : T["type"] extends "number" | "range"
    ? number
    : T["type"] extends "list"
      ? string[]
      : string;

/** Compile-time map from setting key → expected runtime type. Drives the
 *  typed `useSetting<K>` accessor and store typings. */
export type SettingsMap = {
  [E in RawEntry as E["key"]]: ValueOf<E>;
};

export type SettingKey = keyof SettingsMap;

type SchemaField<Entry, Key extends PropertyKey> = Entry extends unknown
  ? Key extends keyof Entry
    ? Entry[Key]
    : never
  : never;

type KeysOfUnion<Entry> = Entry extends unknown ? keyof Entry : never;

/** Generalized consumer shape whose field names and values are derived from
 *  the imported JSON contract. Optional properties remain convenient for
 *  generic controls without a cast that can hide schema drift. */
export type SettingDef = {
  [Key in keyof RawEntry]: SchemaField<RawEntry, Key>;
} & {
  [Key in Exclude<KeysOfUnion<RawEntry>, keyof RawEntry>]?: SchemaField<RawEntry, Key>;
};

/** The settings each built-in feature contributes, by feature id: `features/<id>/settings.schema.json`
 *  (same entry shape as the shared file). Rust appends the same fragments in `config.rs`
 *  (`features::settings_fragments`), so both sides read one merged schema. The Features section
 *  renders a feature's entries under it. */
export const FEATURE_SETTINGS: Readonly<Record<string, readonly SettingDef[]>> = Object.fromEntries(
  Object.entries(
    import.meta.glob<{ settings: SettingDef[] }>("@features/*/settings.schema.json", {
      eager: true,
      import: "default",
    }),
  ).map(([path, fragment]) => [path.split("/").slice(-2)[0], fragment.settings]),
);

/** Core entries followed by every feature's fragment. */
export const SETTINGS_SCHEMA: readonly SettingDef[] = [
  ...schemaFile.settings,
  ...Object.values(FEATURE_SETTINGS).flat(),
];

/** Does a setting apply on this OS? An entry's `platform` names a family, as Rust's
 *  `SettingPlatform`: `macos`, or `linux` for everything else (Windows counts as Linux). Every
 *  place that lists settings as rows asks this, so a Linux-only setting never shows on a Mac. */
export function appliesHere(
  def: { platform?: string },
  platform: Platform = detectPlatform(),
): boolean {
  if (!def.platform) return true;
  return def.platform === (platform === "macos" ? "macos" : "linux");
}

// ---------- Theme primaries ----------

export type ThemeMode = "light" | "dark";

export type PrimarySuffix = "accent" | "background" | "foreground" | "translucent" | "contrast";

/** A flat record keyed by the kebab-case suffix of `theme.{mode}.{suffix}`.
 *  Mirrors the JSON schema names so iteration code uses the same key as the
 *  schema entry without any mapping. */
export type PrimarySet = Record<PrimarySuffix, string | number>;

const PRIMARY_PREFIX = (mode: ThemeMode) => `theme.${mode}.`;

function presetKey(mode: ThemeMode): string {
  return `theme.${mode}.preset`;
}

/** Schema entries describing the editable primaries for a theme mode. UI
 *  iterates these, write paths iterate these, preset compare iterates these.
 *  The hardcoded list lives only in the JSON schema. */
export function getPrimaryDefs(
  mode: ThemeMode,
  platform: Platform = detectPlatform(),
): SettingDef[] {
  const prefix = PRIMARY_PREFIX(mode);
  const presetK = presetKey(mode);
  return SETTINGS_SCHEMA.filter(
    (def) => def.key.startsWith(prefix) && def.key !== presetK && appliesHere(def, platform),
  );
}

export function suffixOf(mode: ThemeMode, key: string): PrimarySuffix {
  return key.slice(PRIMARY_PREFIX(mode).length) as PrimarySuffix;
}
