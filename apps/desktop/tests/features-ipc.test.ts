// featureInvoke and featureEvents: the route, the manifest guard and THE event naming rule.
// @vitest-environment jsdom
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { featureEventName, featureEvents } from "../src/lib/features/events";
import { featureInvoke } from "../src/lib/features/ipc";

afterEach(() => clearMocks());

interface Cmds {
  hello_greet: { args: { name: string }; result: string };
  ping: { args: undefined; result: number };
}
const MANIFEST_COMMANDS = ["hello_greet", "ping"] as const;

describe("featureInvoke", () => {
  it("calls plugin:<id>|<command> with the args", async () => {
    const seen: Array<[string, unknown]> = [];
    mockIPC((cmd, args) => {
      seen.push([cmd, args]);
      return "hello a";
    });
    const call = featureInvoke<Cmds>("fixture-hello", MANIFEST_COMMANDS);
    await expect(call("hello_greet", { name: "a" })).resolves.toBe("hello a");
    await call("ping");
    expect(seen[0]).toEqual(["plugin:fixture-hello|hello_greet", { name: "a" }]);
    expect(seen[1]![0]).toBe("plugin:fixture-hello|ping");
  });

  it("rejects a command the manifest does not declare, without calling Rust", async () => {
    let called = false;
    mockIPC(() => void (called = true));
    const call = featureInvoke<Cmds>("fixture-hello", ["ping"]) as (c: string) => Promise<unknown>;
    await expect(call("hello_greet")).rejects.toThrow(/declares no command/);
    expect(called).toBe(false);
  });

  it("rejects an invalid feature id", () => {
    for (const bad of ["Fixture", "a_b", "a.b", "", "-a"]) {
      expect(() => featureInvoke(bad)).toThrow(/invalid feature id/);
    }
  });
});

describe("event names are <id>:<name> with no dots", () => {
  it("prefixes the feature id", () => {
    expect(featureEventName("word-count", "changed")).toBe("word-count:changed");
    expect(featureEvents<{ changed: number }>("word-count").name("changed")).toBe(
      "word-count:changed",
    );
  });

  it("fails on a dot or any other character Tauri would reject", () => {
    for (const bad of ["a.b", "a b", "a:b", "a/b", "a*", "", "a\n"]) {
      expect(() => featureEventName("word-count", bad), JSON.stringify(bad)).toThrow(
        /illegal event name/,
      );
    }
    // the shape command ids use (`word-count.toggle`) is exactly what must not become an event
    expect(() => featureEventName("word-count", "toggle.changed")).toThrow();
  });

  it("accepts every name Tauri accepts that fits the rule, incl. non-ASCII letters", () => {
    for (const ok of ["changed", "did-change", "did_change", "v2", "é"]) {
      expect(featureEventName("a", ok)).toBe(`a:${ok}`);
    }
  });

  it("listens on the namespaced name", async () => {
    const registered: string[] = [];
    mockIPC((cmd, args) => {
      if (cmd === "plugin:event|listen") registered.push((args as { event: string }).event);
      return 1;
    });
    await featureEvents<{ pinged: number }>("fixture-hello").listen("pinged", () => {});
    expect(registered).toEqual(["fixture-hello:pinged"]);
  });
});
