// `tauri.linux.conf.json` is merged over `tauri.conf.json` on Linux (JSON merge patch, RFC 7396:
// objects merge, arrays are replaced). The merged window is what every Linux window, secondary ones
// included (`build_secondary_window` clones the first window config), starts as.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { DESKTOP } from "./helpers/import-graph";

type Json = unknown;
const read = (file: string): Json => JSON.parse(readFileSync(join(DESKTOP, file), "utf8"));

function mergePatch(target: Json, patch: Json): Json {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const base =
    target !== null && typeof target === "object" && !Array.isArray(target)
      ? { ...(target as Record<string, Json>) }
      : {};
  for (const [key, value] of Object.entries(patch as Record<string, Json>)) {
    if (value === null) delete base[key];
    else base[key] = mergePatch(base[key], value);
  }
  return base;
}

type Window = Record<string, unknown>;
const windowsOf = (conf: Json) => (conf as { app: { windows: Window[] } }).app.windows;

describe("tauri.linux.conf.json", () => {
  const base = read("src-tauri/tauri.conf.json");
  const merged = mergePatch(base, read("src-tauri/tauri.linux.conf.json"));
  const [window] = windowsOf(merged);

  test("one window, with no frame and no transparency", () => {
    expect(windowsOf(merged)).toHaveLength(1);
    expect(window).toMatchObject({ decorations: false, transparent: false, visible: false });
  });

  test("keeps the size keys of the base window", () => {
    const [orig] = windowsOf(base);
    for (const key of ["width", "height", "minWidth", "minHeight", "title"]) {
      expect(window![key], key).toEqual(orig![key]);
    }
  });

  test("drops every macOS-only window key", () => {
    for (const key of ["titleBarStyle", "hiddenTitle", "trafficLightPosition", "windowEffects"]) {
      expect(window, key).not.toHaveProperty(key);
    }
  });

  test("the window permissions are a Linux-only capability", () => {
    const linux = read("src-tauri/capabilities/linux-window.json") as {
      platforms: string[];
      permissions: string[];
    };
    const main = read("src-tauri/capabilities/default.json") as { permissions: string[] };
    expect(linux.platforms).toEqual(["linux"]);
    for (const p of linux.permissions) expect(main.permissions).not.toContain(p);
  });
});
