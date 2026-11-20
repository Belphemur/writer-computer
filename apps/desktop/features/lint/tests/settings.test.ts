// The rule switches: the two lists keep only the difference from the registry's defaults, a
// config file's list of one (a plain string) reads like a list, and the page's reading of the
// rules in force is the one Rust has (`lint::Options::from_lookup`).
// @vitest-environment jsdom
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));

import registry from "../rules.json";
import {
  anySafeRuleEnabled,
  enabledRules,
  fixOnSaveEnabled,
  KEYS,
  listsWith,
  RULES,
} from "../web/lib/settings";

const defaults = registry.rules.filter((r) => r.default).map((r) => r.id);

describe("enabledRules", () => {
  it("is the registry's defaults when nothing was chosen", () => {
    expect([...enabledRules({})].sort()).toEqual([...defaults].sort());
    expect(RULES).toBe(registry.rules);
  });

  it("adds the extra rules, drops the disabled ones and ignores unknown ids", () => {
    const on = enabledRules({ [KEYS.on]: ["MD013", "MD999"], [KEYS.off]: ["MD009"] });
    expect(on.has("MD013")).toBe(true);
    expect(on.has("MD009")).toBe(false);
    expect(on.has("MD999")).toBe(false);
    expect(on.has("MD012")).toBe(true);
  });

  it("reads a list of one as a plain string, like the config file stores it", () => {
    expect(enabledRules({ [KEYS.off]: "MD009" }).has("MD009")).toBe(false);
    expect(enabledRules({ [KEYS.on]: "MD013" }).has("MD013")).toBe(true);
  });

  it("everything off is a list of the defaults", () => {
    expect(enabledRules({ [KEYS.off]: defaults }).size).toBe(0);
    expect(anySafeRuleEnabled({ [KEYS.off]: defaults })).toBe(false);
    expect(anySafeRuleEnabled({})).toBe(true);
  });
});

describe("listsWith", () => {
  it("turning a default off adds it to the off list, and back on removes it", () => {
    const off = listsWith({}, "MD009", false);
    expect(off).toEqual({ on: [], off: ["MD009"] });
    expect(listsWith({ [KEYS.off]: off.off }, "MD009", true)).toEqual({ on: [], off: [] });
  });

  it("turning another rule on adds it to the on list, and back off removes it", () => {
    const on = listsWith({}, "MD013", true);
    expect(on).toEqual({ on: ["MD013"], off: [] });
    expect(listsWith({ [KEYS.on]: on.on }, "MD013", false)).toEqual({ on: [], off: [] });
  });

  it("never records a rule already in the state it is asked for", () => {
    expect(listsWith({}, "MD009", true)).toEqual({ on: [], off: [] });
    expect(listsWith({}, "MD013", false)).toEqual({ on: [], off: [] });
  });
});

describe("fixOnSaveEnabled", () => {
  it("defaults to on and follows the setting", () => {
    expect(fixOnSaveEnabled({})).toBe(true);
    expect(fixOnSaveEnabled({ [KEYS.fixOnSave]: false })).toBe(false);
  });
});
