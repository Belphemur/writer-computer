// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vite-plus/test";
import {
  PLUGIN_ERROR_LOG_MAX,
  errorText,
  recordPluginError,
} from "../src/lib/obsidian-host/error-log";

describe("plugin error log", () => {
  beforeEach(() => {
    delete window.__writerPluginErrors;
  });

  it("records entries on window.__writerPluginErrors", () => {
    recordPluginError("copilot", "load", new Error("boom"));
    const log = window.__writerPluginErrors!;
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ plugin: "copilot", phase: "load" });
    expect(log[0]!.message).toContain("boom");
  });

  it("keeps only the newest entries", () => {
    for (let i = 0; i < PLUGIN_ERROR_LOG_MAX + 5; i++) recordPluginError("p", "load", `e${i}`);
    const log = window.__writerPluginErrors!;
    expect(log).toHaveLength(PLUGIN_ERROR_LOG_MAX);
    expect(log[0]!.message).toBe("e5");
  });

  it("formats non-Error values", () => {
    expect(errorText("x")).toBe("x");
    expect(errorText({ a: 1 })).toBe('{"a":1}');
  });
});
