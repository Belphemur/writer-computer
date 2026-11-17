import { describe, expect, it } from "vite-plus/test";
import {
  AGENT_BACKENDS,
  backendById,
  compareVersions,
  deriveBackendStatus,
  parseVersion,
} from "@features/agent/web/lib/backends";
import type { AgentBinaryInfo } from "@features/agent/web/lib/events";
import {
  CLAUDE_MODEL_CATALOG,
  DEFAULT_ENABLED_MODELS,
  MODEL_CATALOG_VERSION,
  buildModelRows,
  enabledModelChoices,
  isValidModelId,
  modelIdToSetting,
  modelSettingToId,
  modelSupportsEffort,
  normalizeEnabled,
  toggleModel,
} from "@features/agent/web/lib/model-catalog";
import { SETTINGS_SCHEMA } from "@/lib/settings-schema";

describe("backend registry", () => {
  it("has Claude as the only available backend; the rest are coming soon", () => {
    expect(AGENT_BACKENDS.filter((b) => b.status === "available").map((b) => b.id)).toEqual([
      "claude",
    ]);
    expect(AGENT_BACKENDS.map((b) => b.id)).toEqual(["opencode", "claude", "codex", "quick-chat"]);
    for (const b of AGENT_BACKENDS.filter((b) => b.status === "coming-soon")) {
      expect(b.detectCommand).toBeNull();
    }
    expect(backendById("claude")?.minVersion).toBe("2.1.325");
  });

  it("parses and compares versions", () => {
    expect(parseVersion("2.1.325 (Claude Code)")).toEqual([2, 1, 325]);
    expect(parseVersion("nope")).toBeNull();
    expect(compareVersions([2, 1, 324], [2, 1, 325])).toBe(-1);
    expect(compareVersions([2, 2, 0], [2, 1, 325])).toBe(1);
    expect(compareVersions([2, 1, 325], [2, 1, 325])).toBe(0);
  });

  it("derives the badge", () => {
    const claude = backendById("claude")!;
    // The wire always carries every field of `AgentBinaryInfo`; a probe says only what it varies.
    const info = (over: Partial<AgentBinaryInfo>): AgentBinaryInfo => ({
      found: true,
      path: "/c",
      version: "2.1.325 (Claude Code)",
      source: "path",
      searched: [],
      authenticated: null,
      account: null,
      ...over,
    });
    const found = info({});
    expect(deriveBackendStatus(claude, null, null).kind).toBe("checking");
    expect(deriveBackendStatus(claude, null, "boom")).toEqual({ kind: "error", message: "boom" });
    expect(
      deriveBackendStatus(
        claude,
        info({ found: false, path: null, version: null, source: null }),
        null,
      ).kind,
    ).toBe("not-found");
    expect(deriveBackendStatus(claude, found, null).kind).toBe("ready");
    expect(deriveBackendStatus(claude, { ...found, version: "2.1.300" }, null).kind).toBe(
      "unsupported-version",
    );
    expect(deriveBackendStatus(claude, { ...found, authenticated: false }, null).kind).toBe(
      "needs-sign-in",
    );
    expect(deriveBackendStatus(claude, { ...found, version: null }, null).kind).toBe("ready");
    // unknown sign-in state (null) is never "needs sign-in"; only an explicit false is
    expect(deriveBackendStatus(claude, { ...found, authenticated: null }, null).kind).toBe("ready");
    expect(
      deriveBackendStatus(
        claude,
        { ...found, authenticated: true, account: "claude.ai, pro" },
        null,
      ).kind,
    ).toBe("ready");
  });
});

describe("model catalog", () => {
  it("is versioned and starts with the default entry", () => {
    expect(MODEL_CATALOG_VERSION).toBeGreaterThan(0);
    expect(CLAUDE_MODEL_CATALOG[0].id).toBe("default");
    expect(new Set(CLAUDE_MODEL_CATALOG.map((m) => m.id)).size).toBe(CLAUDE_MODEL_CATALOG.length);
    for (const m of CLAUDE_MODEL_CATALOG) expect(isValidModelId(m.id)).toBe(true);
  });

  it("the schema default equals the catalog default", () => {
    const def = SETTINGS_SCHEMA.find((d) => d.key === "agent.enabled-models")!;
    expect(def.default).toEqual([...DEFAULT_ENABLED_MODELS]);
  });

  it("validates ids like the Rust side", () => {
    for (const ok of ["opus", "claude-sonnet-5-5", "my-org/model:1", "m[1m]"])
      expect(isValidModelId(ok), ok).toBe(true);
    for (const bad of ["", "-x", "a b", "a;b", "$(x)"])
      expect(isValidModelId(bad), bad).toBe(false);
  });

  it("normalises the enabled list: default first and always, valid, unique", () => {
    expect(normalizeEnabled(["opus", "opus", "bad id", 5, " haiku "])).toEqual([
      "default",
      "opus",
      "haiku",
    ]);
    expect(normalizeEnabled(undefined)).toEqual([...DEFAULT_ENABLED_MODELS]);
    expect(normalizeEnabled([])).toEqual(["default"]);
  });

  it("toggles models but never switches default off", () => {
    expect(toggleModel(["default", "opus"], "sonnet", true)).toEqual(["default", "opus", "sonnet"]);
    expect(toggleModel(["default", "opus"], "opus", false)).toEqual(["default"]);
    expect(toggleModel(["default", "opus"], "default", false)).toEqual(["default", "opus"]);
  });

  it("adds rows for unknown models (custom, current, session) after the catalog", () => {
    const rows = buildModelRows(["default", "my-org/x"], {
      currentModel: "legacy-1",
      sessionModel: "claude-sonnet-5-5",
    });
    expect(rows.slice(0, CLAUDE_MODEL_CATALOG.length).every((r) => !r.custom)).toBe(true);
    const extra = rows.slice(CLAUDE_MODEL_CATALOG.length);
    expect(extra.map((r) => [r.id, r.enabled, r.custom])).toEqual([
      ["my-org/x", true, true],
      ["legacy-1", false, true],
    ]);
  });

  it("maps the setting to ids and back", () => {
    expect(modelSettingToId("")).toBe("default");
    expect(modelSettingToId("opus")).toBe("opus");
    expect(modelIdToSetting("default")).toBe("");
    expect(modelIdToSetting("opus")).toBe("opus");
  });

  it("knows which models take an effort", () => {
    expect(modelSupportsEffort("")).toBe(true);
    expect(modelSupportsEffort("sonnet")).toBe(true);
    expect(modelSupportsEffort("haiku")).toBe(false);
    expect(modelSupportsEffort("some-custom")).toBe(true);
  });

  it("gives the composer only enabled models plus the chat's current one", () => {
    const choices = enabledModelChoices(["default", "sonnet"], { currentModel: "haiku" });
    expect(choices.map((c) => [c.id, c.value])).toEqual([
      ["default", null],
      ["sonnet", "sonnet"],
      ["haiku", "haiku"],
    ]);
    expect(enabledModelChoices(["default", "sonnet"]).map((c) => c.id)).toEqual([
      "default",
      "sonnet",
    ]);
    expect(enabledModelChoices(undefined).map((c) => c.id)).toEqual([...DEFAULT_ENABLED_MODELS]);
  });
});
