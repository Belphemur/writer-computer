/**
 * The release assets the download button points at, and which file name picks each one out of a
 * release. The suffixes are `apps/desktop/shared/release.json`'s (the release script collects
 * exactly those); the names in between are whatever `tauri build` made, so a release is searched
 * by suffix and never by a name built from the version. No build-time globals here.
 */
import release from "../../desktop/shared/release.json";

/** The packages the page offers; also the ids of their entries in `release.json`. */
export const PACKAGE_IDS = ["mac", "appimage", "deb", "rpm"] as const;
export type PackageId = (typeof PACKAGE_IDS)[number];

/** One download URL per package, and the page to fall back to for a release's own files. */
export type DownloadAssets = Record<PackageId, string> & { releases: string };

/** File-name suffixes that pick each package out of a release's asset list. */
export const ASSET_SUFFIXES = Object.fromEntries(
  PACKAGE_IDS.map((id) => [id, release.assets.find((a) => a.id === id)!.suffix]),
) as Record<PackageId, string>;

/** Every package pointing at one page: what is shown before, or without, a published release. */
export function allAt(url: string): DownloadAssets {
  return { mac: url, appimage: url, deb: url, rpm: url, releases: url };
}
