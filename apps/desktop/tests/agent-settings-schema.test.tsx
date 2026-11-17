// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("../src/lib/preferences", () => ({
  getPreference: vi.fn(async (_k: string, fallback: unknown) => fallback),
  setPreference: vi.fn(async () => {}),
}));

import { SettingsPanel } from "../src/components/settings-panel";
import { agentSettingsFrom } from "../src/lib/agent/agent-settings";
import { SETTINGS_SCHEMA } from "../src/lib/settings-schema";
import { useSettingsStore } from "../src/stores/settings-store";
import { useUIStore } from "../src/stores/ui-store";
import { useWorkspaceStore } from "../src/stores/workspace-store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const agent = SETTINGS_SCHEMA.filter((d) => d.key.startsWith("agent."));
const byKey = (k: string) => agent.find((d) => d.key === k)!;

describe("agent.* settings contract", () => {
  it("defines exactly the documented keys with the spec defaults", () => {
    expect(Object.fromEntries(agent.map((d) => [d.key, d.default]))).toEqual({
      "agent.binary-path": "",
      "agent.model": "",
      "agent.effort": "default",
      "agent.permission-mode": "manual",
      "agent.allowed-tools": [],
      "agent.disallowed-tools": [],
      "agent.attach-active-note": true,
      "agent.inject-agents-md": "auto",
      "agent.max-concurrent-chats": 4,
      "agent.chats-keep-days": 0,
      "agent.pane-width": 420,
    });
  });

  it("is global-only and in the Agent category (a vault's own config cannot choose the program)", () => {
    for (const d of agent) {
      expect(d.scope, d.key).toBe("global");
      expect(d.category, d.key).toBe("Agent");
    }
  });

  it("has the documented option lists", () => {
    expect(byKey("agent.permission-mode").options).toEqual([
      "manual",
      "acceptEdits",
      "plan",
      "auto",
      "dontAsk",
    ]);
    expect(byKey("agent.inject-agents-md").options).toEqual(["auto", "always", "never"]);
    expect(byKey("agent.effort").options).toEqual([
      "default",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(byKey("agent.permission-mode").options).not.toContain("bypassPermissions");
  });

  it("trims the free-text keys", () => {
    expect(byKey("agent.binary-path").normalize).toBe("trim");
    expect(byKey("agent.model").normalize).toBe("trim");
  });

  it("maps to StartSessionRequest settings through agentSettingsFrom", () => {
    const defaults = Object.fromEntries(SETTINGS_SCHEMA.map((d) => [d.key, d.default]));
    expect(agentSettingsFrom(defaults)).toEqual({
      binaryPath: null,
      model: null,
      effort: null,
      permissionMode: "manual",
      allowedTools: [],
      disallowedTools: [],
    });
    expect(
      agentSettingsFrom({
        ...defaults,
        "agent.effort": "high",
        "agent.permission-mode": "acceptEdits",
        "agent.allowed-tools": ["Bash(git status)"],
      }),
    ).toMatchObject({
      effort: "high",
      permissionMode: "acceptEdits",
      allowedTools: ["Bash(git status)"],
    });
  });
});

describe("Settings > Agent", () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "agent_detect_binary") {
        return { found: true, path: "/synthetic/bin/claude", version: "2.1.325", source: "path" };
      }
      if (cmd === "agent_permission_rules") {
        return { allow: ["Bash(ls)"], deny: ["Bash(rm)"] };
      }
      if (cmd === "agent_remove_permission_rule") {
        return undefined;
      }
      return [];
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useSettingsStore.setState({
      settings: Object.fromEntries(SETTINGS_SCHEMA.map((d) => [d.key, d.default])),
      isLoaded: true,
    });
    useUIStore.setState({ settingsSection: "agent" });
    useWorkspaceStore.setState({ root: "/synthetic-vault" });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders the schema rows, the detected binary and the saved rules", async () => {
    await act(async () => {
      root.render(<SettingsPanel isActive />);
    });
    await act(async () => {});
    expect(container.querySelector('[data-settings-category="Agent"]')).not.toBeNull();
    expect(container.textContent).toContain("Permission mode");
    expect(container.querySelector("[data-agent-binary-status]")?.textContent).toContain(
      "/synthetic/bin/claude 2.1.325",
    );
    const rules = container.querySelector("[data-agent-rules]")!;
    expect(rules.textContent).toContain("Bash(ls)");
    expect(rules.textContent).toContain("Bash(rm)");
    const remove = [...rules.querySelectorAll("button")].find((b) => b.textContent === "Remove")!;
    await act(async () => remove.click());
    expect(invokeMock).toHaveBeenCalledWith("agent_remove_permission_rule", {
      projectPath: null,
      rule: "Bash(ls)",
    });
  });
});
