/**
 * Where the download button points and which version the page advertises.
 *
 * The build inlines the version from `tauri.conf.json`. That is only right on the day the site is
 * deployed: the site is redeployed by hand and the app is released far more often, so the
 * prerendered page drifts behind whatever is actually published. `fetchLatestRelease` asks GitHub
 * for the latest published release at page load so the visitor always gets the current one.
 * The build-time value is what the prerendered document shows and what the page keeps if GitHub
 * cannot be reached (offline, or the unauthenticated per-IP rate limit is spent): every package
 * then links to the releases page, never to a file name guessed from the version, which may not
 * exist (a draft, a failed upload, a renamed asset).
 *
 * GitHub's REST API is the one source that answers a browser: the
 * `releases/latest/download/...` redirect the in-app updater follows carries no
 * CORS headers, so the page cannot read `latest.json` the way the app does.
 * `releases/latest` already excludes drafts and prereleases, which is what
 * "published" means here.
 */

import {
  ASSET_SUFFIXES,
  PACKAGE_IDS,
  type DownloadAssets,
  type PackageId,
  allAt,
} from "./release-assets";

export type { DownloadAssets };

export type Release = {
  /** Bare semver, without the tag's leading `v`. */
  version: string;
  assets: DownloadAssets;
};

/** What the build baked in; shown until (and unless) GitHub answers. */
export const BUILD_RELEASE: Release = {
  version: __WRITER_VERSION__,
  assets: allAt(__WRITER_RELEASES_URL__),
};

const RELEASES_URL = __WRITER_RELEASES_URL__;

export const LATEST_RELEASE_URL = `https://api.github.com/repos/${__WRITER_RELEASE_REPO__}/releases/latest`;

const TAG = /^v(\d+\.\d+\.\d+)$/;

/** The URL of the one asset whose name ends in `suffix`, or null. */
function assetUrl(assets: unknown[], suffix: string): string | null {
  for (const asset of assets) {
    if (typeof asset !== "object" || asset === null) continue;
    const { name, browser_download_url } = asset as {
      name?: unknown;
      browser_download_url?: unknown;
    };
    if (typeof name !== "string" || !name.endsWith(suffix)) continue;
    if (typeof browser_download_url === "string" && browser_download_url !== "") {
      return browser_download_url;
    }
  }
  return null;
}

/**
 * Read a `releases/latest` payload down to the fields the page needs: the version and one
 * download per package. Each package is resolved on its own: one that is missing from the
 * release links to the release's page (`html_url`), else to the releases page, so a single absent
 * file never hides the rest. Null only when the payload is not a release with a `v<semver>` tag,
 * so the caller keeps the build-time value.
 */
export function parseLatestRelease(payload: unknown): Release | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { tag_name, assets, html_url } = payload as {
    tag_name?: unknown;
    assets?: unknown;
    html_url?: unknown;
  };
  if (typeof tag_name !== "string" || !Array.isArray(assets)) return null;

  const version = TAG.exec(tag_name)?.[1];
  if (!version) return null;

  const releases = typeof html_url === "string" && html_url !== "" ? html_url : RELEASES_URL;
  const urls = Object.fromEntries(
    PACKAGE_IDS.map((id) => [id, assetUrl(assets, ASSET_SUFFIXES[id]) ?? releases]),
  ) as Record<PackageId, string>;
  return { version, assets: { ...urls, releases } };
}

/**
 * The latest published release, or null when GitHub did not give one: a
 * non-2xx response (a spent rate limit answers 403) or a payload that does not
 * parse. Network failures and aborts reject as `fetch` does.
 */
export async function fetchLatestRelease(signal?: AbortSignal): Promise<Release | null> {
  const response = await fetch(LATEST_RELEASE_URL, {
    headers: { Accept: "application/vnd.github+json" },
    signal,
  });
  if (!response.ok) return null;
  return parseLatestRelease(await response.json());
}
