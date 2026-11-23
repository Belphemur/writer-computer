import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";

// The .deb/.rpm post-install script (src-tauri/linux/post-install.sh) links /usr/bin/writer to
// writer-desktop. It runs as root, so it must never replace what is not ours. Each case runs the
// real script against a temporary "root": /usr/bin in the text is the only thing rewritten.
const SCRIPT = readFileSync(
  join(import.meta.dirname, "../src-tauri/linux/post-install.sh"),
  "utf8",
);

const roots: string[] = [];
afterEach(() => {
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Run the script with `setup` applied to a fresh bin folder; returns the link's path. */
function install(setup: (link: string) => void): string {
  const root = mkdtempSync(join(tmpdir(), "writer-postinst-"));
  roots.push(root);
  const bin = join(root, "usr/bin");
  mkdirSync(bin, { recursive: true });
  const link = join(bin, "writer");
  setup(link);
  const script = join(root, "post-install.sh");
  writeFileSync(script, SCRIPT.replaceAll("/usr/bin", bin));
  execFileSync("sh", [script], { stdio: "pipe" });
  return link;
}

describe("post-install.sh", () => {
  test("links a free name to writer-desktop, relatively", () => {
    const link = install(() => {});
    expect(readlinkSync(link)).toBe("writer-desktop");
  });

  test("relinks its own link (an upgrade)", () => {
    const link = install((l) => symlinkSync("writer-desktop", l));
    expect(readlinkSync(link)).toBe("writer-desktop");
  });

  test("leaves another program's link, dangling or not, alone", () => {
    const other = install((l) => symlinkSync("/opt/other/writer", l));
    expect(readlinkSync(other)).toBe("/opt/other/writer");
    const live = install((l) => {
      writeFileSync(join(l, "..", "real"), "");
      symlinkSync("real", l);
    });
    expect(readlinkSync(live)).toBe("real");
  });

  test("leaves a regular file alone", () => {
    const link = install((l) => writeFileSync(l, "mine"));
    expect(lstatSync(link).isSymbolicLink()).toBe(false);
    expect(readFileSync(link, "utf8")).toBe("mine");
  });
});
