#!/usr/bin/env node
// The release workflow's logic (.github/workflows/release.yml), in one tested place. Never inline
// shell JSON in the workflow; add a subcommand here instead.
//
//   check    --tag vX.Y.Z[-pre]       the tag names the version in tauri.conf.json, Cargo.toml and
//                                     package.json (prints version= and prerelease= for $GITHUB_OUTPUT)
//   notes    --version X.Y.Z          the CHANGELOG section of that version, to stdout
//   collect  --platform P --out DIR   copy the platform's release assets out of the bundle folder and
//                                     write DIR/P.platform.json (updater asset + signature)
//   manifest --dir DIR --tag T --repo OWNER/NAME --notes FILE
//                                     DIR/latest.json from every *.platform.json in DIR (which it
//                                     then deletes, so DIR holds only release assets); fails when
//                                     a required platform is missing
//   glibc    --binary FILE            fails when FILE needs a newer glibc than the floor
//
// The repository, the branch, the asset names and the glibc floor are facts of
// apps/desktop/shared/release.json, read here and by the website, the updater test and distribute.sh.
//
// Every function throws an Error whose message says what to fix; the CLI prints it and exits 1.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TAURI_DIR = join(ROOT, "apps/desktop/src-tauri");

/** The release facts every consumer reads (repository, branch, assets, glibc floor). */
export const RELEASE = JSON.parse(
  readFileSync(join(ROOT, "apps/desktop/shared/release.json"), "utf8"),
);

/** Platforms a release must carry, by the key `latest.json` uses. */
export const REQUIRED_PLATFORMS = [...new Set(RELEASE.assets.map((a) => a.platform))];

/**
 * Per platform: the files that become release assets, as [bundle folder, suffix] and which of them
 * the updater downloads (it has a `.sig` next to it). Each pair must match exactly one file.
 */
export const PLATFORM_ASSETS = Object.fromEntries(
  REQUIRED_PLATFORMS.map((platform) => {
    const mine = RELEASE.assets.filter((a) => a.platform === platform);
    const updater = mine.find((a) => a.updater);
    return [
      platform,
      {
        files: mine.map((a) => [a.folder, a.suffix]),
        updater: [updater.folder, updater.suffix],
      },
    ];
  }),
);

const TAG = /^v(\d+\.\d+\.\d+)(-[0-9A-Za-z.-]+)?$/;

/** `v0.9.0` -> { version: "0.9.0", prerelease: false }; `v0.9.0-rc.1` -> prerelease. */
export function parseTag(tag) {
  const m = TAG.exec(tag ?? "");
  if (!m) {
    throw new Error(
      `Tag "${tag}" is not v<major>.<minor>.<patch> (an -rc.N style suffix is allowed).`,
    );
  }
  return { version: m[1], prerelease: m[2] !== undefined };
}

/** The `[package] version` of a Cargo.toml text. */
export function cargoVersion(toml) {
  const pkg = /^\[package\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(toml);
  const v = pkg && /^version\s*=\s*"([^"]+)"/m.exec(pkg[1]);
  if (!v) throw new Error("No [package] version found in Cargo.toml.");
  return v[1];
}

/** Every version file must equal the tag's version; one error names all the mismatches. */
export function checkVersions(tag, { tauriConf, cargoToml, packageJson }) {
  const { version, prerelease } = parseTag(tag);
  const found = {
    "apps/desktop/src-tauri/tauri.conf.json": JSON.parse(tauriConf).version,
    "apps/desktop/src-tauri/Cargo.toml": cargoVersion(cargoToml),
    "apps/desktop/package.json": JSON.parse(packageJson).version,
  };
  const wrong = Object.entries(found).filter(([, v]) => v !== version);
  if (wrong.length) {
    const lines = wrong.map(([file, v]) => `  ${file} is ${v}`).join("\n");
    throw new Error(
      `Tag ${tag} needs version ${version} in every version file, but:\n${lines}\n` +
        "Bump them in one commit (docs/releasing.md), then move the tag.",
    );
  }
  return { version, prerelease };
}

/** The body of the `## <version>` section of a changelog (heading may carry a v, brackets, a date). */
export function changelogNotes(changelog, version) {
  const lines = changelog.split("\n");
  const heading = new RegExp(`^##\\s+\\[?v?${version.replace(/\./g, "\\.")}\\]?(\\s|$|-)`);
  const start = lines.findIndex((l) => heading.test(l));
  if (start < 0) {
    throw new Error(
      `CHANGELOG.md has no "## ${version}" section. Rename "## Unreleased" (or add the section) ` +
        "before tagging.",
    );
  }
  let end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  if (end < 0) end = lines.length;
  const body = lines
    .slice(start + 1, end)
    .join("\n")
    .trim();
  if (!body) throw new Error(`The CHANGELOG.md section for ${version} is empty.`);
  return `${body}\n`;
}

/** The one file in `dir` ending in `suffix`; zero or several is an error naming the folder. */
function only(dir, suffix) {
  let names = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(suffix));
  } catch {
    // reported below
  }
  if (names.length !== 1) {
    throw new Error(`Expected exactly one *${suffix} in ${dir}, found ${names.length}.`);
  }
  return join(dir, names[0]);
}

/** Copy `platform`'s assets from `bundleDir` into `outDir`; returns the platform descriptor. */
export function collect(platform, bundleDir, outDir) {
  const spec = PLATFORM_ASSETS[platform];
  if (!spec)
    throw new Error(`Unknown platform "${platform}" (${Object.keys(PLATFORM_ASSETS).join(", ")}).`);
  mkdirSync(outDir, { recursive: true });
  for (const [folder, suffix] of spec.files) {
    const file = only(join(bundleDir, folder), suffix);
    copyFileSync(file, join(outDir, basename(file)));
  }
  const updater = only(join(bundleDir, spec.updater[0]), spec.updater[1]);
  const sigFile = `${updater}.sig`;
  const signature = readFileSync(sigFile, "utf8").trim();
  if (!signature) throw new Error(`${sigFile} is empty: is TAURI_SIGNING_PRIVATE_KEY valid?`);
  copyFileSync(sigFile, join(outDir, basename(sigFile)));
  const descriptor = { platform, asset: basename(updater), signature };
  writeFileSync(
    join(outDir, `${platform}.platform.json`),
    `${JSON.stringify(descriptor, null, 2)}\n`,
  );
  return descriptor;
}

/** The highest `GLIBC_x.y` version `objdump -T` lists, as a string, or null when it lists none. */
export function maxGlibc(objdump) {
  const versions = [...objdump.matchAll(/GLIBC_(\d+(?:\.\d+)*)/g)].map((m) => m[1]);
  if (!versions.length) return null;
  const cmp = (a, b) => {
    const [x, y] = [a, b].map((v) => v.split(".").map(Number));
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      const d = (x[i] ?? 0) - (y[i] ?? 0);
      if (d) return d;
    }
    return 0;
  };
  return versions.reduce((hi, v) => (cmp(v, hi) > 0 ? v : hi));
}

/** Throws when the binary's `objdump -T` text needs a glibc newer than `floor`. */
export function checkGlibc(objdump, floor = RELEASE.glibcFloor) {
  const top = maxGlibc(objdump);
  if (top === null) throw new Error("objdump -T listed no GLIBC_ symbol: is this a Linux binary?");
  if (maxGlibc(`GLIBC_${floor} GLIBC_${top}`) !== floor) {
    throw new Error(
      `The binary needs glibc ${top}, above the floor ${floor} (apps/desktop/shared/release.json). ` +
        "Raise the floor and the docs that quote it (docs/releasing.md, README) on purpose, or build on an older base.",
    );
  }
  return top;
}

/** The Tauri updater manifest. Throws when a required platform is missing or twice present. */
export function mergeLatest({
  version,
  notes,
  pubDate,
  tag,
  repo,
  platforms,
  required = REQUIRED_PLATFORMS,
}) {
  const seen = new Set();
  const out = {};
  for (const p of platforms) {
    if (seen.has(p.platform)) throw new Error(`Platform ${p.platform} appears twice.`);
    seen.add(p.platform);
    if (!p.signature) throw new Error(`Platform ${p.platform} has no signature.`);
    out[p.platform] = {
      signature: p.signature,
      url: `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(p.asset)}`,
    };
  }
  const missing = required.filter((r) => !seen.has(r));
  if (missing.length) {
    throw new Error(
      `latest.json would lack ${missing.join(", ")}: a platform build did not produce its assets.`,
    );
  }
  return { version, notes, pub_date: pubDate, platforms: out };
}

/** Write `dir/latest.json` from the `*.platform.json` descriptors in `dir`, then remove those
 *  descriptors: they are build plumbing, not release assets. */
export function writeManifest(dir, { tag, repo, notes, pubDate }) {
  const names = readdirSync(dir)
    .filter((n) => n.endsWith(".platform.json"))
    .sort();
  const manifest = mergeLatest({
    version: parseTag(tag).version,
    notes,
    pubDate,
    tag,
    repo,
    platforms: names.map((n) => JSON.parse(readFileSync(join(dir, n), "utf8"))),
  });
  writeFileSync(join(dir, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const n of names) rmSync(join(dir, n));
  return manifest;
}

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith("--") || argv[i + 1] === undefined)
      throw new Error(`Bad argument: ${argv[i]}`);
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

function need(a, ...names) {
  for (const n of names) if (!a[n]) throw new Error(`Missing --${n}`);
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const a = args(rest);
  const read = (p) => readFileSync(join(ROOT, p), "utf8");
  if (cmd === "check") {
    need(a, "tag");
    const { version, prerelease } = checkVersions(a.tag, {
      tauriConf: read("apps/desktop/src-tauri/tauri.conf.json"),
      cargoToml: read("apps/desktop/src-tauri/Cargo.toml"),
      packageJson: read("apps/desktop/package.json"),
    });
    console.log(`version=${version}`);
    console.log(`prerelease=${prerelease}`);
  } else if (cmd === "notes") {
    need(a, "version");
    process.stdout.write(changelogNotes(read("CHANGELOG.md"), a.version));
  } else if (cmd === "collect") {
    need(a, "platform", "out");
    const bundle = join(
      process.env.CARGO_TARGET_DIR ?? join(TAURI_DIR, "target"),
      "release/bundle",
    );
    const d = collect(a.platform, bundle, resolve(a.out));
    console.log(`collected ${a.platform}: updater asset ${d.asset}`);
  } else if (cmd === "manifest") {
    need(a, "dir", "tag", "repo", "notes");
    const manifest = writeManifest(a.dir, {
      tag: a.tag,
      repo: a.repo,
      notes: readFileSync(a.notes, "utf8").trim(),
      pubDate: new Date().toISOString(),
    });
    console.log(`latest.json: ${Object.keys(manifest.platforms).join(", ")}`);
  } else if (cmd === "glibc") {
    need(a, "binary");
    const top = checkGlibc(execFileSync("objdump", ["-T", a.binary], { encoding: "utf8" }));
    console.log(`glibc: the binary needs ${top}, floor ${RELEASE.glibcFloor}`);
  } else {
    throw new Error(
      "Usage: release.mjs check|notes|collect|manifest|glibc (see the header of this file)",
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }
}
