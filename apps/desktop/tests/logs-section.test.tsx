// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const calls = vi.hoisted(() => ({ lines: [] as string[], written: [] as string[], opened: 0 }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: vi.fn(async (t: string) => void calls.written.push(t)),
}));
vi.mock("../src/lib/tauri", () => ({
  getLogInfo: vi.fn(async () => ({ dir: "/logs/com.writer-computer", envOverride: true })),
  openLogFolder: vi.fn(async () => void calls.opened++),
  recentLogErrors: vi.fn(async () => calls.lines),
}));

import { LogsSection } from "../src/components/settings-panel/logs-section";
import { SETTINGS_SECTIONS } from "../src/components/settings-panel/settings-sections";
import { SETTINGS_SCHEMA } from "../src/lib/settings-schema";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;
beforeEach(async () => {
  calls.lines = ["2026-11-16T10:00:00Z ERROR x boom", "2026-11-16T10:00:01Z WARN y careful"];
  calls.written = [];
  calls.opened = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<LogsSection />));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const button = (label: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent === label)!;

describe("Settings > Logs", () => {
  it("is a registered section with a default-warn level setting", () => {
    const section = SETTINGS_SECTIONS.find((s) => s.id === "logs")!;
    expect(section.blocks).toContainEqual({ type: "logs" });
    const def = SETTINGS_SCHEMA.find((d) => d.key === "diagnostics.log-level")!;
    expect(def.default).toBe("warn");
    expect(def.category).toBe("Logs");
  });

  it("shows the folder and the WRITER_LOG override", () => {
    expect(container.querySelector("[data-log-dir]")!.textContent).toBe(
      "/logs/com.writer-computer",
    );
    expect(container.textContent).toContain("WRITER_LOG is set");
  });

  it("opens the folder", async () => {
    await act(async () => button("Open log folder").click());
    expect(calls.opened).toBe(1);
  });

  it("copies the recent errors and says how many", async () => {
    await act(async () => button("Copy recent errors").click());
    expect(calls.written).toEqual([calls.lines.join("\n")]);
    expect(container.querySelector("[data-logs-message]")!.textContent).toBe("Copied 2 log lines.");
  });

  it("leaves the clipboard alone when there is nothing to copy", async () => {
    calls.lines = [];
    await act(async () => button("Copy recent errors").click());
    expect(calls.written).toEqual([]);
    expect(container.querySelector("[data-logs-message]")!.textContent).toContain("No recent");
  });
});
