import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const sent = vi.hoisted(() => [] as { level: string; [k: string]: unknown }[]);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: { entries: never[] }) => {
    if (cmd === "log_event") sent.push(...args.entries);
  }),
}));

import { logger } from "@/lib/logger";
import { recordPluginError, setPluginVersion } from "../web/host/error-log";
import { wrapAppForDiagnostics } from "../web/host/missing-api-log";
import { CommandRegistry } from "../web/host/api/core";

beforeEach(() => {
  sent.length = 0;
});

describe("plugin errors reach the local log", () => {
  it("carries plugin id, phase, version, message and stack", () => {
    setPluginVersion("copilot", "3.1.0");
    recordPluginError("copilot", "load", new TypeError("x is not a function"));
    logger.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      level: "error",
      source: "plugin",
      plugin: "copilot",
      phase: "load",
      version: "3.1.0",
      message: "TypeError: x is not a function",
    });
    expect(String(sent[0].stack)).toContain("x is not a function");
  });

  it.each(["load", "unload", "seed", "command:execute", "event:file-open", "view-close"])(
    "records the %s phase",
    (phase) => {
      recordPluginError("p-phase", phase, new Error(`failed in ${phase}`));
      logger.flush();
      expect(sent.at(-1)).toMatchObject({ plugin: "p-phase", phase });
    },
  );

  it("logs a missing app member as a warn with the plugin id", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const app = wrapAppForDiagnostics({ vault: {} } as never, "needs-api");
    void (app as unknown as { workspace: { nope: unknown } }).workspace;
    void (app as unknown as { frobnicate: unknown }).frobnicate;
    logger.flush();
    warn.mockRestore();
    expect(sent.at(-1)).toMatchObject({
      level: "warn",
      plugin: "needs-api",
      phase: "missing-api",
    });
    expect(String(sent.at(-1)!.message)).toContain("app.frobnicate");
  });

  it("logs a throwing plugin command with its owner and phase", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const registry = new CommandRegistry(() => null);
    const cmd = registry.addForPlugin("boomer", "Boomer", {
      id: "go",
      name: "Go",
      callback: () => {
        throw new Error("run exploded");
      },
    });
    registry.execute(cmd.id);
    logger.flush();
    const hit = sent.find((e) => e.plugin === "boomer");
    expect(hit).toMatchObject({ source: "plugin", level: "error" });
    expect(String(hit?.phase)).toMatch(/^command:/);
  });
});
