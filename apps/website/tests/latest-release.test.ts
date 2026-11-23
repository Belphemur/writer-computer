import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { BUILD_RELEASE, LATEST_RELEASE_URL, parseLatestRelease } from "../src/latest-release";
import { ASSET_SUFFIXES } from "../src/release-assets";

const BASE = "https://github.com/Belphemur/writer-computer/releases/download/v0.9.0";
const RELEASES = "https://github.com/Belphemur/writer-computer/releases";
const PAGE = `${RELEASES}/tag/v0.9.0`;
const ASSETS = {
  mac: `${BASE}/Writer_0.9.0_aarch64.dmg`,
  appimage: `${BASE}/Writer_0.9.0_amd64.AppImage`,
  deb: `${BASE}/Writer_0.9.0_amd64.deb`,
  rpm: `${BASE}/Writer-0.9.0-1.x86_64.rpm`,
  releases: PAGE,
};

/** The shape `GET /repos/{owner}/{repo}/releases/latest` answers with, trimmed to what matters. */
const payload = {
  tag_name: "v0.9.0",
  draft: false,
  prerelease: false,
  html_url: PAGE,
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
    { name: "Writer_0.9.0_amd64.AppImage", browser_download_url: ASSETS.appimage },
    { name: "Writer_0.9.0_amd64.deb", browser_download_url: ASSETS.deb },
    { name: "Writer-0.9.0-1.x86_64.rpm", browser_download_url: ASSETS.rpm },
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

  test("a missing package links to the release's page and the others keep their files", () => {
    for (const [id, suffix] of [
      ["mac", ".dmg"],
      ["appimage", ".AppImage"],
      ["deb", ".deb"],
      ["rpm", ".rpm"],
    ] as const) {
      const assets = payload.assets.filter((a) => !a.name.endsWith(suffix));
      expect(parseLatestRelease({ ...payload, assets })?.assets).toEqual({
        ...ASSETS,
        [id]: PAGE,
      });
    }
    // An entry whose URL is missing is as good as no entry.
    expect(
      parseLatestRelease({
        ...payload,
        assets: payload.assets.map((a) => (a.name.endsWith(".deb") ? { name: a.name } : a)),
      })?.assets.deb,
    ).toBe(PAGE);
  });

  test("a payload with only the .dmg gives its URL and sends the rest to the releases page", () => {
    const { html_url: _page, ...noPage } = payload;
    const only = payload.assets.filter((a) => a.name.endsWith(".dmg"));
    expect(parseLatestRelease({ ...noPage, assets: only })?.assets).toEqual({
      mac: ASSETS.mac,
      appimage: RELEASES,
      deb: RELEASES,
      rpm: RELEASES,
      releases: RELEASES,
    });
    expect(parseLatestRelease({ ...payload, assets: [] })?.assets.mac).toBe(PAGE);
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
    // Junk entries are no assets: the release still shows, every package on the releases page.
    expect(parseLatestRelease({ tag_name: "v0.9.0", assets: [null, 1, "x"] })?.assets.deb).toBe(
      RELEASES,
    );
    // GitHub's error body for a spent rate limit.
    expect(
      parseLatestRelease({ message: "API rate limit exceeded", documentation_url: "" }),
    ).toBeNull();
  });
});

describe("build-time fallback", () => {
  test("is the built version with every package on the releases page, never a guessed file", () => {
    expect(BUILD_RELEASE.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(BUILD_RELEASE.assets).toEqual({
      mac: RELEASES,
      appimage: RELEASES,
      deb: RELEASES,
      rpm: RELEASES,
      releases: RELEASES,
    });
    expect(LATEST_RELEASE_URL).toBe(
      "https://api.github.com/repos/Belphemur/writer-computer/releases/latest",
    );
  });

  test("names what the shared release file names", () => {
    const shared = JSON.parse(
      readFileSync(join(import.meta.dirname, "../../desktop/shared/release.json"), "utf8"),
    );
    expect(RELEASES).toBe(`https://github.com/${shared.repo}/releases`);
    expect(ASSET_SUFFIXES).toEqual({
      mac: ".dmg",
      appimage: ".AppImage",
      deb: ".deb",
      rpm: ".rpm",
    });
  });
});
