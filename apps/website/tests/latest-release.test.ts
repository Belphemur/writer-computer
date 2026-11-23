import { describe, expect, test } from "vite-plus/test";
import { BUILD_RELEASE, LATEST_RELEASE_URL, parseLatestRelease } from "../src/latest-release";
import { assetUrls } from "../src/release-assets";

const BASE = "https://github.com/Belphemur/writer-computer/releases/download/v0.9.0";
const ASSETS = {
  mac: `${BASE}/Writer_0.9.0_aarch64.dmg`,
  linux: {
    appimage: `${BASE}/Writer_0.9.0_amd64.AppImage`,
    deb: `${BASE}/Writer_0.9.0_amd64.deb`,
    rpm: `${BASE}/Writer-0.9.0-1.x86_64.rpm`,
  },
};

/** The shape `GET /repos/{owner}/{repo}/releases/latest` answers with, trimmed to what matters. */
const payload = {
  tag_name: "v0.9.0",
  draft: false,
  prerelease: false,
  assets: [
    { name: "latest.json", browser_download_url: "https://example.invalid/latest.json" },
    {
      name: "Writer.app.tar.gz",
      browser_download_url: "https://example.invalid/Writer.app.tar.gz",
    },
    {
      name: "Writer_0.9.0_amd64.AppImage.sig",
      browser_download_url: "https://example.invalid/Writer_0.9.0_amd64.AppImage.sig",
    },
    { name: "Writer_0.9.0_aarch64.dmg", browser_download_url: ASSETS.mac },
    { name: "Writer_0.9.0_amd64.AppImage", browser_download_url: ASSETS.linux.appimage },
    { name: "Writer_0.9.0_amd64.deb", browser_download_url: ASSETS.linux.deb },
    { name: "Writer-0.9.0-1.x86_64.rpm", browser_download_url: ASSETS.linux.rpm },
  ],
};

describe("parseLatestRelease", () => {
  test("picks the version off the tag and each platform's package out of the assets", () => {
    expect(parseLatestRelease(payload)).toEqual({ version: "0.9.0", assets: ASSETS });
  });

  test("asset order does not matter", () => {
    expect(parseLatestRelease({ ...payload, assets: [...payload.assets].reverse() })).toEqual({
      version: "0.9.0",
      assets: ASSETS,
    });
  });

  test("a release missing any platform package is not something the buttons can point at", () => {
    for (const suffix of [".dmg", ".AppImage", ".deb", ".rpm"]) {
      const assets = payload.assets.filter((a) => !a.name.endsWith(suffix));
      expect(parseLatestRelease({ ...payload, assets })).toBeNull();
    }
    expect(parseLatestRelease({ ...payload, assets: [] })).toBeNull();
    // An entry whose URL is missing is as good as no entry.
    expect(
      parseLatestRelease({
        ...payload,
        assets: payload.assets.map((a) => (a.name.endsWith(".deb") ? { name: a.name } : a)),
      }),
    ).toBeNull();
  });

  test("a tag that is not v<semver> is rejected rather than shown", () => {
    expect(parseLatestRelease({ ...payload, tag_name: "0.9.0" })).toBeNull();
    expect(parseLatestRelease({ ...payload, tag_name: "v0.9" })).toBeNull();
    expect(parseLatestRelease({ ...payload, tag_name: "v0.9.0-rc1" })).toBeNull();
  });

  test("anything that is not a release object yields null", () => {
    expect(parseLatestRelease(null)).toBeNull();
    expect(parseLatestRelease("v0.9.0")).toBeNull();
    expect(parseLatestRelease({})).toBeNull();
    expect(parseLatestRelease({ tag_name: "v0.9.0" })).toBeNull();
    expect(parseLatestRelease({ tag_name: "v0.9.0", assets: [null, 1, "x"] })).toBeNull();
    // GitHub's error body for a spent rate limit.
    expect(
      parseLatestRelease({ message: "API rate limit exceeded", documentation_url: "" }),
    ).toBeNull();
  });
});

describe("build-time fallback", () => {
  test("is the version and the asset URLs the build inlined, and the API URL names the release repo", () => {
    const v = BUILD_RELEASE.version;
    expect(v).toMatch(/^\d+\.\d+\.\d+$/);
    expect(BUILD_RELEASE.assets).toEqual(assetUrls("Belphemur/writer-computer", v));
    expect(BUILD_RELEASE.assets.mac).toBe(
      `https://github.com/Belphemur/writer-computer/releases/download/v${v}/Writer_${v}_aarch64.dmg`,
    );
    expect(LATEST_RELEASE_URL).toBe(
      "https://api.github.com/repos/Belphemur/writer-computer/releases/latest",
    );
  });
});
