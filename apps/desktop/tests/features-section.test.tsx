// @vitest-environment jsdom
// Settings > Features: generated from the manifests; a feature's settings come from its fragment.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { FeaturesSection } from "../src/components/settings-panel/features-section";
import { FEATURE_MANIFESTS } from "../src/lib/features/manifests";
import { FEATURE_SETTINGS, SETTINGS_SCHEMA } from "../src/lib/settings-schema";
import { useSettingsStore } from "../src/stores/settings-store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;
const setSetting = vi.fn(async () => {});
beforeEach(async () => {
  setSetting.mockClear();
  useSettingsStore.setState({ settings: {}, setSetting } as never);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<FeaturesSection />));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const row = (id: string) => container.querySelector<HTMLElement>(`[data-feature="${id}"]`)!;
const settingsButton = (id: string) =>
  [...row(id).querySelectorAll("button")].find((b) => b.hasAttribute("aria-expanded"));

describe("the merged settings schema", () => {
  it("holds the agent's settings from its fragment, not from the shared file", () => {
    const own = FEATURE_SETTINGS.agent;
    expect(own.length).toBeGreaterThan(0);
    for (const def of own) {
      expect(def.key.startsWith("agent.")).toBe(true);
      expect(SETTINGS_SCHEMA.filter((d) => d.key === def.key)).toHaveLength(1);
    }
    expect(new Set(SETTINGS_SCHEMA.map((d) => d.key)).size).toBe(SETTINGS_SCHEMA.length);
  });
});

describe("Settings > Features", () => {
  it("has a row per manifest", () => {
    for (const m of FEATURE_MANIFESTS) expect(row(m.id)).toBeTruthy();
  });

  it("shows the agent's settings under it, collapsed until asked", async () => {
    const count = FEATURE_SETTINGS.agent.length;
    expect(row("agent").querySelector("[data-setting-key], [role='switch']")).toBeTruthy();
    expect(row("agent").textContent).not.toContain("Claude binary");
    await act(async () => settingsButton("agent")!.click());
    expect(settingsButton("agent")!.textContent).toBe(`Hide settings (${count})`);
    expect(row("agent").textContent).toContain("Claude binary");
  });

  it("shows only the toggle and info for a feature without settings", () => {
    expect(FEATURE_SETTINGS.tables).toBeUndefined();
    expect(row("tables")).toBeTruthy();
    expect(settingsButton("tables")).toBeUndefined();
  });

  it("writes the kill switch", async () => {
    const toggle = row("agent").querySelector<HTMLButtonElement>("[role='switch']")!;
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await act(async () => toggle.click());
    expect(setSetting).toHaveBeenCalledWith("features.agent.enabled", false);
  });
});
