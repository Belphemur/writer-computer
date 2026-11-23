// The log commands' arguments: Tauri reads camelCase keys, so a hand-written snake_case key (the
// bug the git feature just had) would be dropped and the Rust command would fail. The keys the
// wrappers send are checked against the parameter names declared in `commands/logs.rs`.
// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { logTail, logUnwatch, logWatch } from "@/lib/logs";
import { DESKTOP } from "./helpers/import-graph";

afterEach(() => clearMocks());

const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
/** Parameters Tauri injects (not sent by the webview). */
const INJECTED = new Set(["app", "webview", "window"]);

/** `command -> parameter names the webview sends`, read from the Rust source. */
function rustParams(): Map<string, string[]> {
  const src = readFileSync(join(DESKTOP, "src-tauri/src/commands/logs.rs"), "utf8");
  const found = new Map<string, string[]>();
  for (const m of src.matchAll(/#\[tauri::command\]\s*pub async fn (\w+)\(([^)]*)\)/g)) {
    const params = [...m[2]!.matchAll(/(\w+)\s*:(?!:)/g)]
      .map((p) => p[1]!)
      .filter((p) => !INJECTED.has(p))
      .map(camel);
    found.set(m[1]!, params);
  }
  return found;
}

describe("log commands", () => {
  it("send exactly the camelCase names of the Rust parameters", async () => {
    const sent = new Map<string, string[]>();
    mockIPC((cmd, args) => {
      sent.set(cmd, Object.keys((args as object) ?? {}));
      return cmd === "log_watch" ? 1 : [];
    });
    await logTail("git", 200);
    await logWatch("git");
    await logUnwatch(1);
    const rust = rustParams();
    for (const cmd of ["log_tail", "log_watch", "log_unwatch"]) {
      expect(rust.has(cmd), `${cmd} in commands/logs.rs`).toBe(true);
      expect([...(sent.get(cmd) ?? [])].sort(), cmd).toEqual([...rust.get(cmd)!].sort());
    }
  });
});
