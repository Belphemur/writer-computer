// Exact files in the user's home that a named agent plugin may read and replace through `fs`
// (the Rust twin is `plugin_home_files.rs`; keep the two lists equal). Unlike a home mount
// (home-mounts.ts, a virtual folder inside the vault) this is the REAL file, because another
// program (the `claude` CLI) must see the same bytes.
//
// Each entry is one file (no directories, no globs). Rust enforces everything that matters: the
// exact path, the plugin id, a trusted vault and the plugin's remembered "always allow every
// program" spawn consent. This list only keeps the shim from sending requests that Rust would
// refuse and describes the one write pattern the plugin uses (see `staging`).
//
// Copilot saves approved rules like this (read from its bundle, never patched): realpath, access,
// stat, `mkdtemp(<dir>/.copilot-rules-)`, `open(<tmp dir>/settings.json, "wx")`, write, chmod,
// sync, close, `readFileSync(target)` to detect a change, `renameSync(<tmp file>, target)`, then
// `rm(<tmp dir>, {recursive})`. The shim serves that sequence from memory and sends ONE atomic
// write to Rust when the staged file is closed (renameSync cannot await an IPC call).

import { posix } from "./path";

export interface HomeFileEntry {
  /** Path relative to the home directory, `<dir>/<file>`. */
  home: string;
  /** Plugin ids that may use it. */
  plugins: readonly string[];
  /** The temp directory pattern the plugin writes through: `mkdtemp(<dir>/<prefix>)`. */
  staging: { dirPrefix: string; fileName: string };
}

export const HOME_FILES: readonly HomeFileEntry[] = [
  {
    home: ".claude/settings.json",
    plugins: ["copilot"],
    staging: { dirPrefix: ".copilot-rules-", fileName: "settings.json" },
  },
];

const clean = (homedir: string): string => homedir.replace(/\/+$/, "");

/** The entry whose absolute path is exactly `abs`, when `pluginId` may use it. */
export function matchHomeFile(
  homedir: string,
  abs: string,
  pluginId: string,
  files: readonly HomeFileEntry[] = HOME_FILES,
): HomeFileEntry | null {
  return (
    files.find((e) => e.plugins.includes(pluginId) && abs === `${clean(homedir)}/${e.home}`) ?? null
  );
}

/** The entry whose directory holds `<abs>` as a staging prefix (`<dir>/<dirPrefix>`). */
export function matchStagingPrefix(
  homedir: string,
  abs: string,
  pluginId: string,
  files: readonly HomeFileEntry[] = HOME_FILES,
): HomeFileEntry | null {
  return (
    files.find(
      (e) =>
        e.plugins.includes(pluginId) &&
        abs === `${clean(homedir)}/${posix.dirname(e.home)}/${e.staging.dirPrefix}`,
    ) ?? null
  );
}

/** The entry for which `abs` is exactly the directory of the file. */
export function matchHomeFileDir(
  homedir: string,
  abs: string,
  pluginId: string,
  files: readonly HomeFileEntry[] = HOME_FILES,
): HomeFileEntry | null {
  return (
    files.find(
      (e) => e.plugins.includes(pluginId) && abs === `${clean(homedir)}/${posix.dirname(e.home)}`,
    ) ?? null
  );
}
