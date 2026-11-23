import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";

// scripts/release.mjs is the release workflow's logic (ADR 2026-11-23): the tag/version check,
// the changelog notes, the asset collection and the latest.json merge.
const ROOT = join(import.meta.dirname, "../../..");
const release = await import(join(ROOT, "scripts/release.mjs"));

const files = (version: string) => ({
  tauriConf: JSON.stringify({ version }),
  cargoToml: `[package]\nname = "desktop"\nversion = "${version}"\nedition = "2021"\n\n[dependencies]\nserde = { version = "1" }\n`,
  packageJson: JSON.stringify({ version }),
});

describe("tag and version check", () => {
  test("a tag equal to every version file passes", () => {
    expect(release.checkVersions("v0.9.0", files("0.9.0"))).toEqual({
      version: "0.9.0",
      prerelease: false,
    });
  });

  test("a -rc tag is a prerelease of the file version", () => {
    expect(release.checkVersions("v0.9.0-rc.1", files("0.9.0"))).toEqual({
      version: "0.9.0",
      prerelease: true,
    });
  });

  test("a mismatch names every file that disagrees", () => {
    const f = { ...files("0.9.0"), packageJson: JSON.stringify({ version: "0.8.0" }) };
    expect(() => release.checkVersions("v0.9.0", f)).toThrow(
      /apps\/desktop\/package\.json is 0\.8\.0/,
    );
    expect(() => release.checkVersions("v0.9.1", files("0.9.0"))).toThrow(
      /tauri\.conf\.json is 0\.9\.0/,
    );
  });

  test("a tag that is not a version is refused", () => {
    expect(() => release.checkVersions("0.9.0", files("0.9.0"))).toThrow(/not v<major>/);
    expect(() => release.checkVersions("v1.2", files("1.2.0"))).toThrow(/not v<major>/);
  });

  test("the repository's own version files agree with each other", () => {
    const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
    const version = JSON.parse(read("apps/desktop/src-tauri/tauri.conf.json")).version;
    expect(
      release.checkVersions(`v${version}`, {
        tauriConf: read("apps/desktop/src-tauri/tauri.conf.json"),
        cargoToml: read("apps/desktop/src-tauri/Cargo.toml"),
        packageJson: read("apps/desktop/package.json"),
      }),
    ).toMatchObject({ version });
  });
});

describe("changelog notes", () => {
  const log =
    "# Changelog\n\n## Unreleased\n\n- next\n\n## 0.9.0 - 2026-11-24\n\n- one\n- two\n\n## 0.8.0\n\n- old\n";

  test("returns the body of the version's section only", () => {
    expect(release.changelogNotes(log, "0.9.0")).toBe("- one\n- two\n");
    expect(release.changelogNotes(log, "0.8.0")).toBe("- old\n");
  });

  test("accepts [v0.9.0] headings", () => {
    expect(release.changelogNotes("## [v0.9.0] (today)\n\n- x\n", "0.9.0")).toBe("- x\n");
  });

  test("a missing or empty section fails", () => {
    expect(() => release.changelogNotes(log, "0.10.0")).toThrow(/no "## 0\.10\.0" section/);
    expect(() => release.changelogNotes("## 0.9.0\n\n## 0.8.0\n- a\n", "0.9.0")).toThrow(/empty/);
  });
});

describe("latest.json merge", () => {
  const platforms = [
    { platform: "darwin-aarch64", asset: "Writer.app.tar.gz", signature: "SIG-MAC" },
    { platform: "linux-x86_64", asset: "Writer_0.9.0_amd64.AppImage", signature: "SIG-LINUX" },
  ];
  const base = {
    version: "0.9.0",
    notes: "n",
    pubDate: "2026-11-24T00:00:00Z",
    tag: "v0.9.0",
    repo: "Belphemur/writer-computer",
  };

  test("names both platforms with the release download URLs and signatures", () => {
    expect(release.mergeLatest({ ...base, platforms })).toEqual({
      version: "0.9.0",
      notes: "n",
      pub_date: "2026-11-24T00:00:00Z",
      platforms: {
        "darwin-aarch64": {
          signature: "SIG-MAC",
          url: "https://github.com/Belphemur/writer-computer/releases/download/v0.9.0/Writer.app.tar.gz",
        },
        "linux-x86_64": {
          signature: "SIG-LINUX",
          url: "https://github.com/Belphemur/writer-computer/releases/download/v0.9.0/Writer_0.9.0_amd64.AppImage",
        },
      },
    });
  });

  test("a missing platform fails", () => {
    expect(() => release.mergeLatest({ ...base, platforms: platforms.slice(0, 1) })).toThrow(
      /lack linux-x86_64/,
    );
    expect(() => release.mergeLatest({ ...base, platforms: platforms.slice(1) })).toThrow(
      /lack darwin-aarch64/,
    );
  });

  test("an unsigned or duplicated platform fails", () => {
    expect(() =>
      release.mergeLatest({
        ...base,
        platforms: [{ ...platforms[0], signature: "" }, platforms[1]],
      }),
    ).toThrow(/no signature/);
    expect(() => release.mergeLatest({ ...base, platforms: [...platforms, platforms[0]] })).toThrow(
      /twice/,
    );
  });
});

describe("collect", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function bundle(layout: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), "writer-release-"));
    dirs.push(dir);
    for (const [path, body] of Object.entries(layout)) {
      mkdirSync(join(dir, "bundle", path, ".."), { recursive: true });
      writeFileSync(join(dir, "bundle", path), body);
    }
    return { bundle: join(dir, "bundle"), out: join(dir, "out") };
  }

  const linux = {
    "appimage/Writer_0.9.0_amd64.AppImage": "img",
    "appimage/Writer_0.9.0_amd64.AppImage.sig": "SIG\n",
    "deb/Writer_0.9.0_amd64.deb": "deb",
    "rpm/Writer-0.9.0-1.x86_64.rpm": "rpm",
  };

  test("copies the linux assets and describes the updater one", () => {
    const { bundle: b, out } = bundle(linux);
    expect(release.collect("linux-x86_64", b, out)).toEqual({
      platform: "linux-x86_64",
      asset: "Writer_0.9.0_amd64.AppImage",
      signature: "SIG",
    });
    expect(readdirSync(out).sort()).toEqual([
      "Writer-0.9.0-1.x86_64.rpm",
      "Writer_0.9.0_amd64.AppImage",
      "Writer_0.9.0_amd64.AppImage.sig",
      "Writer_0.9.0_amd64.deb",
      "linux-x86_64.platform.json",
    ]);
  });

  test("copies the macOS dmg and the updater tarball", () => {
    const { bundle: b, out } = bundle({
      "dmg/Writer_0.9.0_aarch64.dmg": "dmg",
      "macos/Writer.app.tar.gz": "tar",
      "macos/Writer.app.tar.gz.sig": "SIG-MAC",
    });
    expect(release.collect("darwin-aarch64", b, out).asset).toBe("Writer.app.tar.gz");
    expect(readdirSync(out)).toContain("Writer_0.9.0_aarch64.dmg");
  });

  test("a missing bundle, a missing or empty signature all fail", () => {
    const { "deb/Writer_0.9.0_amd64.deb": _deb, ...noDeb } = linux;
    const a = bundle(noDeb);
    expect(() => release.collect("linux-x86_64", a.bundle, a.out)).toThrow(/exactly one \*\.deb/);
    const { "appimage/Writer_0.9.0_amd64.AppImage.sig": _sig, ...noSig } = linux;
    const b = bundle(noSig);
    expect(() => release.collect("linux-x86_64", b.bundle, b.out)).toThrow();
    const c = bundle({ ...linux, "appimage/Writer_0.9.0_amd64.AppImage.sig": "\n" });
    expect(() => release.collect("linux-x86_64", c.bundle, c.out)).toThrow(/is empty/);
    expect(() => release.collect("windows", c.bundle, c.out)).toThrow(/Unknown platform/);
  });
});
