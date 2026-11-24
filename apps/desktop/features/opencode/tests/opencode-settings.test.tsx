// @vitest-environment jsdom
// Settings > Agent > OpenCode: the tab the `agent.backends` point adds, its status card, the models
// table (provider tabs, chips, search, the Enabled switch writing `agent.opencode.disabled-models`), the saved
// permission rules, and the kill switch taking all of it away.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { memoryOverview } from "@features/agent/tests/memory-fixture";
import { MODELS, STATUS_READY } from "./fixtures";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@/lib/preferences", () => ({
  getPreference: vi.fn(async (_k: string, fallback: unknown) => fallback),
  setPreference: vi.fn(async () => {}),
}));

import agentFeature from "@features/agent/web/index";
import opencodeFeature from "../web/index";
import { featureHost } from "@/lib/features/registry";
import {
  agentBackendContributions,
  invalidateBackendModels,
  resetBackendModelsForTests,
} from "@/lib/features/agent-backends";
import { featuresWithOwnPage } from "@/lib/features/settings-sections";
import { useFeatureSections } from "@/hooks/use-feature-sections";
import { SettingsPanel } from "@/components/settings-panel";
import { SETTINGS_SCHEMA } from "@/lib/settings-schema";
import { resetBackendUsabilityForTests } from "@features/agent/web/stores/backend-usability";
import { useSettingsStore } from "@/stores/settings-store";
import { useUIStore } from "@/stores/ui-store";
import { useWorkspaceStore } from "@/stores/workspace-store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DISABLED_KEY = "agent.opencode.disabled-models";

describe("Settings > Agent > OpenCode", { timeout: 30_000 }, () => {
  let container: HTMLElement;
  let root: Root;
  let status: unknown;
  let models: () => Promise<unknown>;
  let rules: { id: string; action: string; resource: string }[];
  let projectScoped: boolean;
  let removeError: Error | null;
  const writes: [string, unknown][] = [];
  const calls: [string, unknown][] = [];
  const q = (sel: string) => container.querySelector<HTMLElement>(sel);
  const qa = (sel: string) => [...container.querySelectorAll<HTMLElement>(sel)];
  const flush = () => act(async () => {});
  const button = (text: string) =>
    [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
  const rows = () => qa("[data-opencode-model]").map((r) => r.dataset.opencodeModel);

  async function openTab() {
    await act(async () => root.render(<SettingsPanel isActive />));
    await vi.waitFor(() => expect(q("[data-agent-backend-tab=opencode]")).not.toBeNull(), {
      timeout: 20_000,
    });
    await act(async () => q("[data-agent-backend-tab=opencode]")!.click());
    // every wait has the same generous deadline: the first render pulls a lazy chunk, and a loaded
    // machine takes seconds for it (the default one second made this flaky)
    await vi.waitFor(
      () => expect(q("[data-agent-status]")?.dataset.agentStatus).not.toBe("checking"),
      { timeout: 20_000 },
    );
    // the panel is a lazy chunk of the feature
    await vi.waitFor(() => expect(q("[data-opencode-panel]")).not.toBeNull(), { timeout: 20_000 });
    await flush();
  }

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
    writes.length = 0;
    calls.length = 0;
    resetBackendUsabilityForTests();
    resetBackendModelsForTests();
    status = STATUS_READY;
    models = async () => MODELS;
    rules = [{ id: "psv_fake1", action: "bash", resource: "git status" }];
    projectScoped = true;
    removeError = null;
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      calls.push([cmd, args]);
      if (cmd === "plugin:agent|agent_detect_binary")
        return { found: true, path: "/synthetic/bin/claude", version: "2.1.325", source: "path" };
      if (cmd === "plugin:agent|agent_memory_list") return memoryOverview({ vaultFiles: [] });
      if (cmd === "plugin:opencode|opencode_status") {
        if (status instanceof Error) throw status;
        return status;
      }
      if (cmd === "plugin:opencode|opencode_models") return models();
      if (cmd === "plugin:opencode|opencode_saved_rules") return { rules, projectScoped };
      if (cmd === "plugin:opencode|opencode_remove_saved_rule") {
        if (removeError) throw removeError;
        rules = rules.filter((r) => r.id !== args.id);
        return null;
      }
      if (cmd === "set_setting") {
        writes.push([String(args.key), args.value]);
        return args.value;
      }
      return [];
    });
    featureHost.register(agentFeature);
    featureHost.register(opencodeFeature);
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

  afterEach(async () => {
    act(() => root.unmount());
    container.remove();
    await featureHost.unregister("opencode");
    await featureHost.unregister("agent");
  });

  it("adds a tab next to Claude, enabled, and Codex stays coming soon", async () => {
    await openTab();
    const tab = (id: string) => q(`[data-agent-backend-tab=${id}]`);
    await vi.waitFor(
      () => {
        expect(qa("[data-agent-backend-tab]").map((t) => t.dataset.agentBackendTab)).toEqual([
          "claude",
          "opencode",
          "codex",
        ]);
        expect(tab("opencode")?.hasAttribute("disabled")).toBe(false);
        expect(tab("opencode")?.getAttribute("aria-selected")).toBe("true");
      },
      { timeout: 20_000 },
    );
    expect(q("[data-opencode-panel]")?.textContent).toContain(
      "Your own OpenCode config does not apply.",
    );
  });

  describe("status card", () => {
    it("Ready: path and version", async () => {
      await openTab();
      expect(q("[data-agent-status]")?.dataset.agentStatus).toBe("ready");
      expect(q("[data-agent-binary-status]")?.textContent).toContain("/synthetic/bin/opencode");
      expect(q("[data-agent-binary-status]")?.textContent).toContain("2.4.0");
    });

    it("Not found: Install instructions and Locate, in OpenCode's own words", async () => {
      status = { ...STATUS_READY, found: false, path: null, version: null };
      await openTab();
      expect(q("[data-agent-status]")?.dataset.agentStatus).toBe("not-found");
      expect(q("[data-agent-binary-status]")?.textContent).toContain("OpenCode was not found");
      expect(q("[data-agent-binary-status]")?.textContent).not.toMatch(/claude/i);
      expect(button("Install instructions")).toBeTruthy();
      expect(button("Locate…")).toBeTruthy();
    });

    it("Unsupported version", async () => {
      status = { ...STATUS_READY, version: "2.3.0", supported: false };
      await openTab();
      expect(q("[data-agent-status]")?.dataset.agentStatus).toBe("unsupported-version");
      expect(q("[data-agent-binary-status]")?.textContent).toContain("2.4.0");
    });

    it("a version the backend calls unsupported is Unsupported, whatever the number", async () => {
      status = { ...STATUS_READY, version: "3.0.0", supported: false, minVersion: "2.4.0" };
      await openTab();
      expect(q("[data-agent-status]")?.dataset.agentStatus).toBe("unsupported-version");
      expect(q("[data-agent-binary-status]")?.textContent).toContain("3.0.0");
      expect(q("[data-agent-binary-status]")?.textContent).toContain("2.4.0");
    });

    it("a version the backend calls supported is Ready, with no minimum of Writer's own", async () => {
      status = { ...STATUS_READY, version: "2.0.1", supported: true, minVersion: "1.0.0" };
      await openTab();
      expect(q("[data-agent-status]")?.dataset.agentStatus).toBe("ready");
    });

    it("Could not check", async () => {
      status = new Error("probe failed");
      await openTab();
      expect(q("[data-agent-status]")?.dataset.agentStatus).toBe("error");
      expect(q("[data-agent-binary-status]")?.textContent).toContain("probe failed");
    });

    it("Re-detect asks again", async () => {
      await openTab();
      const before = calls.filter(([c]) => c === "plugin:opencode|opencode_status").length;
      await act(async () => button("Re-detect")!.click());
      await flush();
      expect(calls.filter(([c]) => c === "plugin:opencode|opencode_status").length).toBe(
        before + 1,
      );
    });
  });

  describe("models table", () => {
    it("shows a loading line, then every model with provider, marks, window and cost", async () => {
      let release!: () => void;
      models = () => new Promise((r) => (release = () => r(MODELS)));
      await openTab();
      expect(q("[data-opencode-loading]")).not.toBeNull();
      expect(q("[data-opencode-models]")).toBeNull();
      await act(async () => release());
      await flush();
      expect(rows()).toEqual(["acme/big-1", "acme/small-1", "zed/free-1", "zed/retired-1"]);
      const big = q("[data-opencode-model='acme/big-1']")!;
      expect(big.textContent).toContain("Big One");
      expect(big.textContent).toContain("Acme AI");
      expect(big.textContent).toContain("1M");
      expect(big.textContent).toContain("$0.30 / $2.50");
      expect(big.querySelector("[aria-label='Reasoning']")).not.toBeNull();
      expect(big.querySelector("[aria-label='PDF input']")).not.toBeNull();
      expect(q("[data-opencode-model='zed/free-1']")?.textContent).toContain("Free");
      expect(q("[data-opencode-model='zed/retired-1']")?.textContent).toContain("-");
    });

    it("shows the error and Retry when the list cannot be read", async () => {
      models = async () => {
        throw new Error("server did not start");
      };
      await openTab();
      expect(q("[data-opencode-error]")?.textContent).toContain("server did not start");
      models = async () => MODELS;
      await act(async () => button("Retry")!.click());
      await flush();
      expect(q("[data-opencode-error]")).toBeNull();
      expect(rows()).toHaveLength(4);
    });

    const tab = (name: string) => q(`[data-opencode-tab='${name}']`) as HTMLButtonElement;
    const chip = (id: string) => q(`[data-opencode-chip=${id}]`) as HTMLButtonElement;
    const type = async (value: string) => {
      const search = q("input[aria-label='Search models']") as HTMLInputElement;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          search,
          value,
        );
        search.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };

    it("has All first, then a tab per provider from the list", async () => {
      await openTab();
      expect(qa("[data-opencode-tab]").map((t) => t.textContent)).toEqual([
        "All",
        "Acme AI",
        "Zed Labs",
      ]);
      expect(tab("all").getAttribute("aria-selected")).toBe("true");
      await act(async () => tab("provider:Zed Labs").click());
      expect(rows()).toEqual(["zed/free-1", "zed/retired-1"]);
      expect(tab("provider:Zed Labs").getAttribute("aria-selected")).toBe("true");
    });

    it("the provider tabs are a roving tablist: ArrowRight moves to the next tab and selects it", async () => {
      await openTab();
      expect(tab("all").tabIndex).toBe(0);
      expect(tab("provider:Acme AI").tabIndex).toBe(-1);
      const arrow = async (key: string) =>
        act(async () => {
          document.activeElement!.dispatchEvent(
            new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
          );
        });
      tab("all").focus();
      await arrow("ArrowRight");
      expect(tab("provider:Acme AI").getAttribute("aria-selected")).toBe("true");
      expect(document.activeElement).toBe(tab("provider:Acme AI"));
      expect(rows()).toEqual(["acme/big-1", "acme/small-1"]);
      await arrow("ArrowRight");
      await arrow("ArrowRight");
      // wraps back to All
      expect(tab("all").getAttribute("aria-selected")).toBe("true");
      await arrow("ArrowLeft");
      expect(tab("provider:Zed Labs").getAttribute("aria-selected")).toBe("true");
    });

    it("the Enabled and Free chips combine with the tab and the search", async () => {
      await openTab();
      await act(async () => chip("free").click());
      expect(chip("free").getAttribute("aria-pressed")).toBe("true");
      expect(rows()).toEqual(["zed/free-1"]);
      await act(async () => chip("free").click());
      await act(async () => chip("enabled").click());
      // the retired model is not enabled
      expect(rows()).toEqual(["acme/big-1", "acme/small-1", "zed/free-1"]);
      await act(async () => tab("provider:Acme AI").click());
      expect(rows()).toEqual(["acme/big-1", "acme/small-1"]);
      await type("small");
      expect(rows()).toEqual(["acme/small-1"]);
      await act(async () => chip("free").click());
      expect(q("[data-opencode-models]")?.textContent).toContain("No models match.");
    });

    it("searches over name and provider", async () => {
      await openTab();
      await type("zed");
      expect(rows()).toEqual(["zed/free-1", "zed/retired-1"]);
      await type("nothing");
      expect(q("[data-opencode-models]")?.textContent).toContain("No models match.");
    });

    it("falls back to All when the selected provider leaves a refreshed list", async () => {
      await openTab();
      await act(async () => tab("provider:Zed Labs").click());
      expect(rows()).toEqual(["zed/free-1", "zed/retired-1"]);
      models = async () => MODELS.filter((m) => m.providerId === "acme");
      await act(async () => {
        invalidateBackendModels("opencode");
      });
      await flush();
      expect(qa("[data-opencode-tab]").map((t) => t.textContent)).toEqual(["All", "Acme AI"]);
      expect(tab("all").getAttribute("aria-selected")).toBe("true");
      expect(rows()).toEqual(["acme/big-1", "acme/small-1"]);
    });

    it("the Enabled switch writes agent.opencode.disabled-models and the Enabled chip follows", async () => {
      await openTab();
      const sw = () =>
        q("[data-opencode-model='acme/small-1'] button[role=switch]") as HTMLButtonElement;
      expect(sw().getAttribute("aria-checked")).toBe("true");
      await act(async () => sw().click());
      await flush();
      expect(writes).toContainEqual([DISABLED_KEY, ["acme/small-1"]]);
      expect(sw().getAttribute("aria-checked")).toBe("false");
      await act(async () => chip("enabled").click());
      expect(rows()).toEqual(["acme/big-1", "zed/free-1"]);
      // and back on
      await act(async () => chip("enabled").click());
      await act(async () => sw().click());
      await flush();
      expect(writes.at(-1)).toEqual([DISABLED_KEY, []]);
    });

    it("a model the server turned off is dimmed and its switch cannot be used", async () => {
      await openTab();
      const row = q("[data-opencode-model='zed/retired-1']")!;
      expect(row.dataset.unavailable).toBe("true");
      expect(row.querySelector<HTMLButtonElement>("button[role=switch]")!.disabled).toBe(true);
    });

    it("only 50 rows are drawn until Show more", async () => {
      models = async () =>
        Array.from({ length: 120 }, (_, i) => ({ ...MODELS[1]!, id: `p/m${i}`, name: `M${i}` }));
      await openTab();
      expect(rows()).toHaveLength(50);
      await act(async () => q("[data-opencode-more]")!.click());
      expect(rows()).toHaveLength(100);
    });
  });

  describe("model and tier selects", () => {
    it("offer the enabled models only and write the chosen slug", async () => {
      useSettingsStore.setState((s) => ({
        settings: { ...s.settings, [DISABLED_KEY]: ["acme/small-1"] },
      }));
      await openTab();
      const select = q("select[aria-label='Default model']") as HTMLSelectElement;
      expect([...select.options].map((o) => o.value)).toEqual(["", "acme/big-1", "zed/free-1"]);
      await act(async () => {
        select.value = "zed/free-1";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(writes).toContainEqual(["agent.opencode.model", "zed/free-1"]);
    });

    it("the effort select offers the model's selectable levels and is off without any", async () => {
      useSettingsStore.setState((s) => ({
        settings: { ...s.settings, "agent.opencode.model": "acme/big-1" },
      }));
      await openTab();
      const effort = q("select[aria-label='Default effort']") as HTMLSelectElement;
      expect([...effort.options].map((o) => o.value)).toEqual(["default", "low", "high", "max"]);
      useSettingsStore.setState((s) => ({
        settings: { ...s.settings, "agent.opencode.model": "acme/small-1" },
      }));
      await flush();
      expect((q("select[aria-label='Default effort']") as HTMLSelectElement).disabled).toBe(true);
    });

    it("three tier rows write agent.opencode.model-<tier>", async () => {
      await openTab();
      const tiers = qa("[data-opencode-tier]").map((t) => t.dataset.opencodeTier);
      expect(tiers).toEqual(["cheap", "standard", "strong"]);
      const select = q("[data-opencode-tier=cheap] select") as HTMLSelectElement;
      await act(async () => {
        select.value = "acme/big-1";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(writes).toContainEqual(["agent.opencode.model-cheap", "acme/big-1"]);
    });
  });

  describe("saved permission rules", () => {
    it("lists the rules, says nothing about the account, and removes one by id", async () => {
      await openTab();
      expect(q("[data-opencode-rule=psv_fake1]")?.textContent).toContain("git status");
      // no sentence under the heading: the list is the vault's project's
      expect(q("[data-opencode-rules]")?.textContent).not.toMatch(/account/i);
      await act(async () => q("[data-opencode-rule=psv_fake1] button")!.click());
      await flush();
      expect(calls).toContainEqual([
        "plugin:opencode|opencode_remove_saved_rule",
        { id: "psv_fake1" },
      ]);
      expect(q("[data-opencode-rule=psv_fake1]")).toBeNull();
      expect(q("[data-opencode-rules]")?.textContent).toContain("No saved rules.");
    });
  });

  describe("saved permission rules, scope", () => {
    it("this project's rules can be removed; a refusal of the backend shows and the row stays", async () => {
      rules = [
        { id: "psv_mine", action: "bash", resource: "ls" },
        { id: "psv_other", action: "bash", resource: "rm" },
      ];
      removeError = new Error("that rule is not in this vault's list");
      await openTab();
      expect(q("[data-opencode-rules-scope]")).toBeNull();
      await act(async () => q("[data-opencode-rule=psv_other] button")!.click());
      await flush();
      expect(q("[data-opencode-rules]")?.textContent).toContain("not in this vault's list");
      expect(q("[data-opencode-rule=psv_other]")).not.toBeNull();
      removeError = null;
      await act(async () => q("[data-opencode-rule=psv_mine] button")!.click());
      await flush();
      expect(q("[data-opencode-rule=psv_mine]")).toBeNull();
    });

    it("while the project is not known the list says All projects and cannot be changed", async () => {
      projectScoped = false;
      await openTab();
      expect(q("[data-opencode-rules-scope]")?.textContent).toBe("All projects");
      expect(q("[data-opencode-rule=psv_fake1]")?.textContent).toContain("git status");
      expect(q("[data-opencode-rule=psv_fake1] button")).toBeNull();
    });
  });

  describe("one model loader", () => {
    const modelCalls = () => calls.filter(([c]) => c === "plugin:opencode|opencode_models").length;

    it("Retry forgets the list and asks again", async () => {
      models = async () => {
        throw new Error("server did not start");
      };
      await openTab();
      expect(modelCalls()).toBe(1);
      models = async () => MODELS;
      await act(async () => button("Retry")!.click());
      await flush();
      expect(modelCalls()).toBe(2);
      expect(rows()).toHaveLength(4);
    });

    it("an empty answer (the server still settling) is not kept", async () => {
      models = async () => [];
      await openTab();
      expect(modelCalls()).toBe(1);
      models = async () => MODELS;
      invalidateBackendModels("opencode");
      await flush();
      expect(rows()).toHaveLength(4);
      expect(modelCalls()).toBe(2);
    });
  });

  describe("the Settings sidebar", () => {
    it("has no generated page for a feature whose tab is part of Settings > Agent", async () => {
      const Probe = () => (
        <pre data-ids>
          {useFeatureSections()
            .map((s) => s.id)
            .join(",")}
        </pre>
      );
      await act(async () => root.render(<Probe />));
      expect(q("[data-ids]")?.textContent).not.toContain("feature:opencode");
      expect(
        featuresWithOwnPage([{ owner: "builtin:agent" }], [{ owner: "builtin:opencode" }]),
      ).toEqual(new Set(["agent", "opencode"]));
    });
  });

  describe("the Default agent row", () => {
    it("shows with two usable agents and writes agent.default-backend", async () => {
      await openTab();
      const select = await vi.waitFor(
        () => {
          const s = q("select[aria-label='Default agent']") as HTMLSelectElement | null;
          expect(s).not.toBeNull();
          return s!;
        },
        { timeout: 20_000 },
      );
      expect([...select.options].map((o) => o.value)).toEqual(["claude", "opencode"]);
      await act(async () => {
        select.value = "opencode";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(writes).toContainEqual(["agent.default-backend", "opencode"]);
    });

    it("is absent while OpenCode is not found", async () => {
      status = { ...STATUS_READY, found: false, path: null, version: null };
      await openTab();
      await flush();
      expect(q("select[aria-label='Default agent']")).toBeNull();
    });
  });

  describe("kill switch", () => {
    it("turning the feature off removes the backend and its tab", async () => {
      await openTab();
      expect(agentBackendContributions.list().map((b) => b.backendId)).toEqual(["opencode"]);
      await act(async () => {
        await featureHost.unregister("opencode");
      });
      await flush();
      expect(agentBackendContributions.size).toBe(0);
      expect(q("[data-agent-backend-tab=opencode]")).toBeNull();
      // the page falls back to Claude's tab
      expect(q("[data-agent-backend-tab=claude]")?.getAttribute("aria-selected")).toBe("true");
      // and a second registration brings it back
      featureHost.register(opencodeFeature);
      await flush();
      expect(agentBackendContributions.size).toBe(1);
    });
  });
});
