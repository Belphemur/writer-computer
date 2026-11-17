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

/** Read-only `writer` commands only; Rust test `default_allowed_tools_are_read_only_registered_commands` checks the names. */
const DEFAULT_ALLOWED = [
  "Bash(writer search *)",
  "Bash(writer search:context *)",
  "Bash(writer backlinks *)",
  "Bash(writer links *)",
  "Bash(writer properties *)",
  "Bash(writer property:read *)",
  "Bash(writer bases)",
  "Bash(writer base:views *)",
  "Bash(writer base:query *)",
  "Bash(writer version)",
];

const agent = SETTINGS_SCHEMA.filter((d) => d.key.startsWith("agent."));
const byKey = (k: string) => agent.find((d) => d.key === k)!;

describe("agent.* settings contract", () => {
  it("defines exactly the documented keys with the spec defaults", () => {
    expect(Object.fromEntries(agent.map((d) => [d.key, d.default]))).toEqual({
      "agent.binary-path": "",
      "agent.model": "",
      "agent.effort": "default",
      "agent.enabled-models": ["default", "opus", "sonnet", "haiku"],
      "agent.permission-mode": "manual",
      "agent.allowed-tools": DEFAULT_ALLOWED,
      "agent.disallowed-tools": [],
      "agent.attach-active-note": true,
      "agent.share-open-tabs": true,
      "agent.show-turn-changes": true,
      "agent.inject-agents-md": "auto",
      "agent.max-concurrent-chats": 4,
      "agent.chats-keep-days": 0,
      "agent.auto-title-chats": true,
      "agent.title-model": "",
      "agent.orchestrate": true,
      "agent.subagent-model": "haiku",
      "agent.restore-chats": true,
      "agent.pane-width": 420,
      "agent.pane-open": false,
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
    expect(byKey("agent.title-model").normalize).toBe("trim");
    expect(byKey("agent.subagent-model").normalize).toBe("trim");
  });

  it("maps to StartSessionRequest settings through agentSettingsFrom", () => {
    const defaults = Object.fromEntries(SETTINGS_SCHEMA.map((d) => [d.key, d.default]));
    expect(agentSettingsFrom(defaults)).toEqual({
      binaryPath: null,
      model: null,
      effort: null,
      permissionMode: "manual",
      allowedTools: DEFAULT_ALLOWED,
      disallowedTools: [],
      orchestrate: true,
      subagentModel: "haiku",
    });
    expect(
      agentSettingsFrom({
        ...defaults,
        "agent.orchestrate": false,
        "agent.subagent-model": "  ",
        "agent.effort": "high",
        "agent.permission-mode": "acceptEdits",
        "agent.allowed-tools": ["Bash(git status)"],
      }),
    ).toMatchObject({
      effort: "high",
      permissionMode: "acceptEdits",
      allowedTools: ["Bash(git status)"],
      orchestrate: false,
      subagentModel: null,
    });
  });
});

describe("Settings > Agent", () => {
  let container: HTMLElement;
  let root: Root;
  const setCalls: [string, unknown][] = [];
  let detect: Record<string, unknown>;

  const flush = () => act(async () => {});
  async function mount() {
    await act(async () => {
      root.render(<SettingsPanel isActive />);
    });
    await flush();
  }
  const q = (sel: string) => container.querySelector<HTMLElement>(sel);
  const buttonByText = (text: string, within: ParentNode = container) =>
    [...within.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);

  beforeEach(() => {
    window.matchMedia ??= ((query: string) => ({
      matches: false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      onchange: null,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    setCalls.length = 0;
    detect = { found: true, path: "/synthetic/bin/claude", version: "2.1.325", source: "path" };
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === "plugin:agent|agent_detect_binary") return detect;
      if (cmd === "plugin:agent|agent_permission_rules")
        return { allow: ["Bash(ls)"], deny: ["Bash(rm)"] };
      if (cmd === "set_setting") {
        setCalls.push([String(args.key), args.value]);
        return args.value;
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

  it("shows Claude active and the other backends as disabled coming-soon pills", async () => {
    await mount();
    const tabs = [...container.querySelectorAll<HTMLButtonElement>("[data-agent-backend-tab]")];
    expect(tabs.map((t) => t.dataset.agentBackendTab)).toEqual([
      "opencode",
      "claude",
      "codex",
      "quick-chat",
    ]);
    expect(tabs.filter((t) => t.getAttribute("aria-selected") === "true")).toHaveLength(1);
    for (const t of tabs.filter((t) => t.dataset.agentBackendTab !== "claude")) {
      expect(t.disabled).toBe(true);
      expect(t.title).toMatch(/Coming soon/);
    }
  });

  it("header: Ready with the detected path and version", async () => {
    await mount();
    expect(q("[data-agent-status]")?.dataset.agentStatus).toBe("ready");
    expect(q("[data-agent-binary-status]")?.textContent).toContain("/synthetic/bin/claude");
    expect(q("[data-agent-binary-status]")?.textContent).toContain("2.1.325");
  });

  it("header: not found offers Install instructions and Locate", async () => {
    detect = { found: false, path: null, version: null, source: null };
    await mount();
    expect(q("[data-agent-status]")?.dataset.agentStatus).toBe("not-found");
    expect(buttonByText("Install instructions")).toBeTruthy();
    expect(buttonByText("Locate…")).toBeTruthy();
  });

  it("header: an older CLI warns, a signed-out one asks to sign in", async () => {
    detect = { found: true, path: "/synthetic/bin/claude", version: "2.0.1", source: "path" };
    await mount();
    expect(q("[data-agent-status]")?.dataset.agentStatus).toBe("unsupported-version");
    expect(q("[data-agent-binary-status]")?.textContent).toMatch(/2\.1\.325 and later/);
    act(() => root.unmount());
    root = createRoot(container);
    detect = {
      found: true,
      path: "/x/claude",
      version: "2.1.325",
      source: "path",
      authenticated: false,
    };
    await mount();
    expect(q("[data-agent-status]")?.dataset.agentStatus).toBe("needs-sign-in");
  });

  it("Re-detect asks the backend again", async () => {
    await mount();
    const before = invokeMock.mock.calls.filter(
      (c) => c[0] === "plugin:agent|agent_detect_binary",
    ).length;
    await act(async () => buttonByText("Re-detect")!.click());
    await flush();
    expect(
      invokeMock.mock.calls.filter((c) => c[0] === "plugin:agent|agent_detect_binary").length,
    ).toBe(before + 1);
  });

  it("Configure opens a dialog with the path override and the saved rules", async () => {
    await mount();
    await act(async () => buttonByText("Configure")!.click());
    await flush();
    const dialog = q('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Configure Claude");
    expect(dialog.querySelector('input[aria-label="Claude program path"]')).not.toBeNull();
    const rules = dialog.querySelector("[data-agent-rules]")!;
    expect(rules.textContent).toContain("Bash(ls)");
    expect(rules.textContent).toContain("Bash(rm)");
    await act(async () => buttonByText("Remove", rules)!.click());
    expect(invokeMock).toHaveBeenCalledWith("plugin:agent|agent_remove_permission_rule", {
      projectPath: null,
      rule: "Bash(ls)",
    });
    await act(async () => buttonByText("Done")!.click());
    expect(q('[role="dialog"]')).toBeNull();
  });

  it("lists the catalog with the enabled count and toggles models", async () => {
    await mount();
    expect(q("[data-agent-models-count]")?.textContent).toBe("4");
    const rows = [...container.querySelectorAll<HTMLElement>("[data-agent-model]")].map(
      (r) => r.dataset.agentModel,
    );
    expect(rows.slice(0, 4)).toEqual(["default", "opus", "sonnet", "haiku"]);
    expect(rows).toContain("claude-sonnet-5-5");
    const sw = q('[data-agent-model="claude-sonnet-5-5"] [role="switch"]')!;
    expect(sw.getAttribute("aria-checked")).toBe("false");
    await act(async () => sw.click());
    await flush();
    expect(useSettingsStore.getState().settings["agent.enabled-models"]).toEqual([
      "default",
      "opus",
      "sonnet",
      "haiku",
      "claude-sonnet-5-5",
    ]);
  });

  it("filters models by search and adds a custom model", async () => {
    await mount();
    const search = q('input[aria-label="Search Claude models"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        search,
        "haiku",
      );
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(
      [...container.querySelectorAll<HTMLElement>("[data-agent-model]")].map(
        (r) => r.dataset.agentModel,
      ),
    ).toEqual(["haiku", "claude-haiku-5-5", "claude-haiku-4-5"]);
    const add = q('input[aria-label="Add custom model"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(add, "--bad");
      add.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      add.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(q('[role="alert"]')?.textContent).toMatch(/letters, digits/);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        add,
        "my-org/model:1",
      );
      add.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      add.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    await flush();
    expect(useSettingsStore.getState().settings["agent.enabled-models"]).toContain(
      "my-org/model:1",
    );
  });

  it("greys the effort select out for a model without effort levels", async () => {
    useSettingsStore.setState({
      settings: {
        ...useSettingsStore.getState().settings,
        "agent.model": "haiku",
      },
    });
    await mount();
    const effort = q('select[aria-label="Default effort"]') as HTMLSelectElement;
    expect(effort.disabled).toBe(true);
    const model = q('select[aria-label="Default model"]') as HTMLSelectElement;
    expect(model.value).toBe("haiku");
  });

  it("explains auto mode and edits the rule lists; bypass is not offered", async () => {
    await mount();
    expect(container.textContent).toContain("Auto mode permissions");
    expect(container.textContent).toMatch(/never offers a mode that skips permission/);
    expect(container.textContent).toContain("Always-allowed tools");
    expect(container.textContent).toContain("Never-allowed tools");
    expect(container.textContent).not.toContain("bypassPermissions (");
  });

  it("keeps the remaining agent rows (chats and context)", async () => {
    await mount();
    for (const label of [
      "Attach the open note",
      "Inject AGENTS.md",
      "Chats running at once",
      "Keep chat history for (days)",
      "Agent pane width",
    ]) {
      expect(container.textContent, label).toContain(label);
    }
  });
});
