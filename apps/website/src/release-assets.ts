/**
 * The release assets the download button points at, and the one place their names are known.
 * The names are what `tauri build` makes (productName "Writer"); `.github/workflows/release.yml`
 * uploads them unchanged. No build-time globals here: `vite.config.ts` imports this too.
 */

/** One download URL per platform package. */
export type DownloadAssets = {
  mac: string;
  linux: { appimage: string; deb: string; rpm: string };
};

/** File-name suffixes that pick each asset out of a release's asset list. */
export const ASSET_SUFFIXES = {
  mac: ".dmg",
  appimage: ".AppImage",
  deb: ".deb",
  rpm: ".rpm",
} as const;

/** The asset URLs of `version` on `repo` (`owner/name`), as the release workflow names them. */
export function assetUrls(repo: string, version: string): DownloadAssets {
  const base = `https://github.com/${repo}/releases/download/v${version}`;
  return {
    mac: `${base}/Writer_${version}_aarch64.dmg`,
    linux: {
      appimage: `${base}/Writer_${version}_amd64.AppImage`,
      deb: `${base}/Writer_${version}_amd64.deb`,
      rpm: `${base}/Writer-${version}-1.x86_64.rpm`,
    },
  };
}
