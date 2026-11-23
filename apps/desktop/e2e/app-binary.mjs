// The one place that knows where the e2e build puts the app and how it is built, per OS.
// Used by wdio.conf.js (which binary to launch) and build-app.mjs (how to build it).
//
// `productName` names the macOS bundle ("Writer.app"); the executable inside keeps
// `mainBinaryName` from tauri.conf.json ("writer-desktop"), which is also the file Linux's
// `--no-bundle` build leaves in target/<profile>/.
//
// `WRITER_E2E_APP` points at a copy of the build output so parallel work can rebuild the original
// underneath a running spec: a Writer.app on macOS, the binary itself on Linux.
// `WRITER_E2E_DEBUG=1` builds and runs the debug profile (a release build links with LTO and takes
// many minutes; the smoke does not need it).
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const tauriDir = resolve(here, "../src-tauri");

const conf = JSON.parse(readFileSync(resolve(tauriDir, "tauri.conf.json"), "utf8"));
export const BINARY = conf.mainBinaryName;
export const DEBUG = process.env.WRITER_E2E_DEBUG === "1";
const profile = DEBUG ? "debug" : "release";
// Cargo's output folder: `CARGO_TARGET_DIR` when set (CI caches and the Linux container use it).
const targetDir = process.env.CARGO_TARGET_DIR
  ? resolve(process.env.CARGO_TARGET_DIR)
  : resolve(tauriDir, "target");

/** @param {NodeJS.Platform} platform */
export function appBinary(platform = process.platform, env = process.env) {
  if (platform === "darwin") {
    const app = env.WRITER_E2E_APP
      ? resolve(env.WRITER_E2E_APP)
      : resolve(targetDir, profile, "bundle/macos/Writer.app");
    return resolve(app, "Contents/MacOS", BINARY);
  }
  return env.WRITER_E2E_APP ? resolve(env.WRITER_E2E_APP) : resolve(targetDir, profile, BINARY);
}

/** `cargo tauri build` arguments after `--features e2e`: a bundle is only needed on macOS. */
export function buildArgs(platform = process.platform) {
  const bundle = platform === "darwin" ? ["--bundles", "app"] : ["--no-bundle"];
  return [...(DEBUG ? ["--debug"] : []), ...bundle];
}

export const E2E_CONFIG = JSON.stringify({
  identifier: "com.writer-computer.e2e",
  bundle: { createUpdaterArtifacts: false },
});
