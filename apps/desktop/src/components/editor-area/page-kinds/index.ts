import { baseKind, type BaseLocation } from "./base";
import { codeKind, type CodeLocation } from "./code";
import { fileKind, type FileLocation } from "./file";
import { graphKind, type GraphLocation } from "./graph";
import { imageKind, type ImageLocation } from "./image";
import { launcherKind, type LauncherLocation } from "./launcher";
import { pluginFileKind, type PluginFileLocation } from "./plugin-file";
import { pluginViewKind, type PluginViewLocation } from "./plugin-view";
import { sessionChangesKind, type SessionChangesLocation } from "./session-changes";
import { settingsKind, type SettingsLocation } from "./settings";
import { isFeatureActive } from "@/lib/features/active";
import type { AnyPageKind, PageKind, SerializedLocation } from "./types";

/**
 * The single place to register a page kind. Add a new module under
 * `page-kinds/` and one entry here; no other file in the registry needs to
 * change. TypeScript derives the `Location` union from this list, so a kind
 * that's declared here is usable everywhere and a kind that's missing is a
 * type error at every call site.
 */
const kinds = [
  fileKind,
  baseKind,
  graphKind,
  codeKind,
  imageKind,
  launcherKind,
  settingsKind,
  pluginViewKind,
  pluginFileKind,
  sessionChangesKind,
] as const;

export type Location =
  | FileLocation
  | BaseLocation
  | GraphLocation
  | CodeLocation
  | ImageLocation
  | LauncherLocation
  | SettingsLocation
  | PluginViewLocation
  | PluginFileLocation
  | SessionChangesLocation;

const byKind: Map<string, AnyPageKind> = new Map(
  kinds.map((k) => [k.kind, k as unknown as AnyPageKind]),
);

/** Resolve a location to its registered `PageKind`. Throws if the kind is
 *  unregistered — that's always a programmer error. */
export function pageKind<L extends Location>(location: L): PageKind<L["kind"], L> {
  const k = byKind.get(location.kind);
  if (!k) throw new Error(`Unknown page kind: ${location.kind}`);
  return k as unknown as PageKind<L["kind"], L>;
}

/** Alias retained for call sites that read like "give me the behavior" rather
 *  than "give me the page kind." Same registry either way. */
export const locationBehavior = pageKind;

/** The location that opens a workspace file path: the first kind that claims it via `forPath`
 *  (a `.base` opens as a table), else the text editor. The single place that routes a path. */
export function locationForPath(
  path: string,
): FileLocation | BaseLocation | CodeLocation | ImageLocation | PluginFileLocation {
  for (const k of kinds) {
    // A kind whose feature is off claims nothing: its files open as text.
    if (k.feature && !isFeatureActive(k.feature)) continue;
    const location = (
      k.forPath as (
        path: string,
      ) => FileLocation | BaseLocation | CodeLocation | ImageLocation | PluginFileLocation | null
    )(path);
    if (location) return location;
  }
  return { kind: "file", path };
}

/** Is `path` read into the editor store as a text document (vs. rendered by its own kind)? */
export function opensAsDocument(path: string): boolean {
  const location = locationForPath(path);
  return pageKind(location).loadsDocument;
}

export function serializeLocation(location: Location): SerializedLocation | null {
  const payload = pageKind(location).serialize(location);
  if (payload === null) return null;
  return { kind: location.kind, ...payload };
}

/** Agnostic: iterates the registry via `fromPayload`, so adding a kind
 *  doesn't touch this function. Unknown kinds return `null` and the caller
 *  drops the entry. */
export function deserializeLocation(data: SerializedLocation | null | undefined): Location | null {
  if (!data) return null;
  const k = byKind.get(data.kind);
  if (!k) return null;
  return k.fromPayload(data) as Location | null;
}

export type { PageKind, SerializedLocation, AnyPageKind } from "./types";
export type { FileLocation } from "./file";
export type { BaseLocation } from "./base";
export type { GraphLocation, GraphCamera } from "./graph";
export { withGraphState } from "./graph";
export type { CodeLocation } from "./code";
export type { ImageLocation } from "./image";
export type { LauncherLocation } from "./launcher";
export type { SettingsLocation } from "./settings";
export type { PluginViewLocation } from "./plugin-view";
export type { PluginFileLocation } from "./plugin-file";
export type { SessionChangesLocation } from "./session-changes";
