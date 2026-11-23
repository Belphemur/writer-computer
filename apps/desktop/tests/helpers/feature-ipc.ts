// The one contract test of a feature's web IPC client, shared by every `features/<id>/tests/*-ipc`
// test (`describeFeatureIpc`). Tauri reads command arguments by their camelCase names, so a
// hand-typed `chat_id` is dropped and the Rust command fails at runtime. The generated
// `web/bindings.ts` (tauri-specta) is the truth of the route and the argument names; this drives
// every wrapper of the feature's client through `mockIPC` and holds it to that:
//
// - the commands of the manifest, of the bindings and of the wrappers are one set;
// - each wrapper makes one call, on `plugin:<id>|<command>`, with exactly the bindings' argument
//   names (all camelCase) and exactly the values the entry says: every argument of an entry is a
//   distinct sentinel, so two same-typed arguments swapped in a wrapper fail here.
//
// `tests/feature-ipc-guard.test.ts` makes sure every feature with commands uses this, and that no
// feature web code reaches a command by a raw `invoke`.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { DESKTOP } from "./import-graph";

/** Route name to argument names, as the generated bindings of a feature spell them. */
export function bindingArgs(id: string): Map<string, string[]> {
  const source = readFileSync(resolve(DESKTOP, `features/${id}/web/bindings.ts`), "utf8");
  const out = new Map<string, string[]>();
  for (const m of source.matchAll(
    new RegExp(`"plugin:${id}\\|(\\w+)"(?:, \\{ ([^}]*) \\})?`, "g"),
  )) {
    out.set(m[1]!, m[2] ? m[2].split(",").map((k: string) => k.trim()) : []);
  }
  return out;
}

export interface FeatureIpc {
  id: string;
  /** `manifest.rust.commands`. */
  commands: readonly string[];
  /** Every wrapper called once by command: `args` is the object the call must send (every
   *  argument given, a distinct sentinel each; `null` for an option the wrapper leaves out). */
  calls: Record<string, { call: () => Promise<unknown>; args: Record<string, unknown> }>;
  /** Commands no wrapper of the web half calls (Rust-only callers: the CLI, the agent). */
  unwrapped?: readonly string[];
}

export function describeFeatureIpc({ id, commands, calls, unwrapped = [] }: FeatureIpc) {
  afterEach(() => clearMocks());
  const bindings = bindingArgs(id);

  describe(`the ${id} commands`, () => {
    it("are the same set in the manifest, the generated bindings and the wrappers", () => {
      const declared = [...commands].sort();
      expect([...bindings.keys()].sort()).toEqual(declared);
      expect([...Object.keys(calls), ...unwrapped].sort()).toEqual(declared);
    });

    it("are invoked on the plugin route with the argument names the bindings spell", async () => {
      const seen: [string, Record<string, unknown> | undefined][] = [];
      mockIPC((cmd, args) => {
        seen.push([cmd, args as Record<string, unknown> | undefined]);
        return null;
      });
      for (const [name, { call, args }] of Object.entries(calls)) {
        seen.length = 0;
        // A wrapper may fail reading the empty answer; the call it made is what is checked.
        await call().catch(() => {});
        expect(seen, name).toHaveLength(1);
        expect(seen[0]![0], name).toBe(`plugin:${id}|${name}`);
        const keys = Object.keys(seen[0]![1] ?? {}).sort();
        expect(keys, name).toEqual([...bindings.get(name)!].sort());
        expect(seen[0]![1] ?? {}, name).toEqual(args);
        for (const key of keys) expect(key, `${name}: ${key}`).toMatch(/^[a-z][A-Za-z0-9]*$/);
      }
    });
  });
}
