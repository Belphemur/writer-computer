// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(async () => true), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({ get: async () => undefined, set: async () => {} })),
}));
vi.mock("@/lib/tauri", () => ({
  fuzzySearch: async () => [],
  resolveWikiLinkTarget: vi.fn(),
  recentLogErrors: vi.fn(async () => []),
  openLogFolder: vi.fn(),
}));

import { AgentPane } from "@features/agent/web/components/agent-pane";
import { reduceEvent } from "@features/agent/web/lib/reduce";
import { reportedMatches, shortModelName } from "@features/agent/web/lib/model-label";
import { createMockAgentClient, type Goldens } from "@features/agent/web/lib/mock-client";
import { useSettingsStore } from "@/stores/settings-store";
import {
  configureAgentRuntimeForTests,
  useAgentStore,
} from "@features/agent/web/stores/agent-store";
import { AGENT_PANE_DEFAULT_WIDTH, usePaneStore } from "@features/agent/web/stores/pane-store";
import { goldens } from "@features/agent/tests/helpers/agent-goldens";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("model labels", () => {
  it("shortens ids and compares aliases with the reported model", () => {
    expect(shortModelName(null)).toBe("Default");
    expect(shortModelName("opus")).toBe("Opus");
    expect(shortModelName("claude-opus-5-5")).toBe("Opus 5.5");
    expect(shortModelName("claude-fable-6-0-20270101")).toBe("Fable 6.0");
    expect(shortModelName("my/custom")).toBe("my/custom");
    expect(reportedMatches("opus", "claude-opus-5-5")).toBe(true);
    expect(reportedMatches("opus", "claude-haiku-5-5")).toBe(false);
    expect(reportedMatches("claude-sonnet-5-5", "claude-sonnet-5-5")).toBe(true);
    expect(reportedMatches(null, "claude-haiku-5-5")).toBe(true);
  });
});

describe("the model chip", () => {
  let container: HTMLElement;
  let root: Root;
  let setModel: ReturnType<typeof vi.fn>;
  let start: ReturnType<typeof vi.fn>;
  let setSetting: ReturnType<typeof vi.fn>;
  const $ = (sel: string) => container.querySelector<HTMLElement>(sel);
  const $$ = (sel: string) => [...container.querySelectorAll<HTMLElement>(sel)];
  const flush = async (ms = 0) =>
    act(async () => void (await new Promise((r) => setTimeout(r, ms))));
  const key = (el: Element, k: string) =>
    act(
      () =>
        void el.dispatchEvent(
          new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }),
        ),
    );
  const chip = () => $("[data-agent-model-chip]")!;
  const chatId = () => useAgentStore.getState().activeChatId!;
  const choose = async (label: RegExp) => {
    act(() => chip().click());
    const item = $$("[role=menuitemradio]").find((b) =>
      label.test((b.textContent ?? "").replace("✓ ", "")),
    )!;
    act(() => item.click());
    await flush();
  };
  const sendHello = async () => {
    await act(async () => await useAgentStore.getState().sendMessage("hello"));
    await flush(20);
  };

  beforeEach(async () => {
    const mock = createMockAgentClient({ goldens: goldens as unknown as Goldens });
    setModel = vi.fn(async () => {});
    start = vi.fn(mock.start);
    setSetting = vi.fn(async () => {});
    configureAgentRuntimeForTests({ ...mock, setModel, start } as typeof mock);
    useSettingsStore.setState({ settings: {}, setSetting } as never);
    usePaneStore.setState({ open: false, width: AGENT_PANE_DEFAULT_WIDTH });
    useAgentStore.setState({
      chats: {},
      order: [],
      activeChatId: null,
      drafts: {},
      queued: {},
      modes: {},
      chatModels: {},
      modelPending: {},
      notes: {},
      resuming: {},
      skills: {},
      cliCatalog: null,
      view: "chat",
      backend: "tauri",
      binaries: {
        claude: {
          found: true,
          path: "/x",
          version: "1",
          source: "path",
          searched: [],
          authenticated: true,
          account: null,
        },
      },
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => useAgentStore.getState().openPane());
    await act(async () => root.render(<AgentPane />));
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows Default and lists the enabled models, the current one checked", () => {
    expect(chip().textContent).toContain("Default");
    act(() => chip().click());
    const labels = $$("[role=menuitemradio]").map((b) => b.textContent);
    expect(labels.some((l) => l!.includes("Opus"))).toBe(true);
    expect($("[role=menuitemradio][aria-checked=true]")!.textContent).toContain("Default");
  });

  it("switching while idle before the first message sets the next start, no live call", async () => {
    await choose(/^Opus$/);
    expect(setModel).not.toHaveBeenCalled();
    expect(chip().textContent).toContain("Opus");
    await sendHello();
    expect(start.mock.calls[0]![0].settings.model).toBe("opus");
  });

  it("switching in a running session calls set_model live", async () => {
    await sendHello();
    expect(useAgentStore.getState().chats[chatId()]!.session).not.toBeNull();
    await choose(/^Haiku$/);
    expect(setModel).toHaveBeenCalledWith({ chatId: chatId(), model: "haiku", effort: null });
    expect(useAgentStore.getState().chatModels[chatId()]!.model).toBe("haiku");
  });

  it("a failing live switch shows the error and reverts the chip to the old model", async () => {
    await sendHello();
    const before = chip().textContent;
    setModel.mockRejectedValueOnce(new Error("nope"));
    await choose(/^Opus$/);
    expect(useAgentStore.getState().chatModels[chatId()]).toBeUndefined();
    expect(useAgentStore.getState().modelPending[chatId()]).toBeUndefined();
    expect(chip().textContent).toBe(before);
    expect(useAgentStore.getState().chats[chatId()]!.error?.message).toContain("nope");
  });

  it("a live switch shows the new model at once, pending, until the CLI confirms it", async () => {
    await sendHello();
    let release!: () => void;
    setModel.mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
    await choose(/^Opus$/);
    // selected, request still in flight: the chip already reads Opus, with the pending hint
    expect(chip().textContent).toContain("Opus");
    expect(chip().hasAttribute("data-pending")).toBe(true);
    act(() => chip().click());
    expect($("[data-agent-model-footer]")!.textContent).toBe("Switching to Opus…");
    act(() => chip().click());
    await act(async () => release());
    expect(chip().hasAttribute("data-pending")).toBe(true); // sent, not yet confirmed
    // the CLI's next report naming the model settles it
    const id = chatId();
    act(() =>
      useAgentStore.getState().ingest(
        id,
        [
          {
            type: "usage",
            scope: "turn",
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            costUsd: null,
            contextWindow: null,
            model: "claude-opus-5-5",
          },
        ],
        useAgentStore.getState().chats[id]!.lastSeq + 1,
      ),
    );
    expect(chip().hasAttribute("data-pending")).toBe(false);
    expect(chip().textContent).toContain("Opus 5.5");
  });

  it("an effort change is pending too", async () => {
    await sendHello();
    act(() => chip().click());
    act(() => $("[aria-label='Effort high']")!.click());
    await flush();
    expect(chip().hasAttribute("data-pending")).toBe(true);
  });

  it("shows the model the CLI reports, even when it differs from the request", async () => {
    await choose(/^Opus$/);
    const id = chatId();
    act(() =>
      useAgentStore.setState((s) => ({
        chats: {
          ...s.chats,
          [id]: reduceEvent(
            s.chats[id]!,
            {
              type: "usage",
              scope: "turn",
              inputTokens: 1,
              outputTokens: 1,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
              costUsd: null,
              contextWindow: null,
              model: "claude-haiku-5-5",
            },
            Date.now(),
          ),
        },
      })),
    );
    expect(chip().textContent).toContain("Haiku 5.5");
    expect(chip().getAttribute("title")).toContain("Requested Opus");
  });

  it("a model refused by the organization is dropped: chip shows the real model, notice, no retry", async () => {
    let handler: ((e: unknown) => void) | undefined;
    const base = createMockAgentClient({ goldens: goldens as unknown as Goldens });
    configureAgentRuntimeForTests({
      ...base,
      setModel,
      subscribe: async (h: (e: unknown) => void) => {
        handler = h;
        return base.subscribe(h as never);
      },
    } as never);
    await sendHello();
    await choose(/^Opus$/);
    expect(useAgentStore.getState().chatModels[chatId()]!.model).toBe("opus");
    const seq = useAgentStore.getState().chats[chatId()]!.lastSeq + 1;
    await act(async () => {
      handler!({
        chatId: chatId(),
        seq,
        event: { type: "model-refused", requested: "opus", using: "claude-haiku-5-5" },
      });
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(useAgentStore.getState().chatModels[chatId()]!.model).toBe("claude-haiku-5-5");
    expect(chip().textContent).toContain("Haiku 5.5");
    expect($("[data-agent-banner]")!.textContent).toBe(
      "Model opus is not available in your organization; using claude-haiku-5-5",
    );
  });

  it("is keyboard accessible: arrows move, Enter picks, Escape closes", async () => {
    act(() => chip().click());
    const first = document.activeElement as HTMLElement;
    expect(first.getAttribute("role")).toBe("menuitemradio");
    key($("[role=menu]")!, "ArrowDown");
    expect(document.activeElement).not.toBe(first);
    key($("[role=menu]")!, "ArrowUp");
    expect(document.activeElement).toBe(first);
    key($("[role=menu]")!, "Escape");
    expect($("[role=menu]")).toBeNull();
    act(() => chip().click());
    key($("[role=menu]")!, "ArrowDown");
    act(() => (document.activeElement as HTMLElement).click()); // Enter on a button is a click
    await flush();
    expect(useAgentStore.getState().chatModels[chatId()]).toBeDefined();
  });

  it("offers effort for models that take it, hides it for Haiku, and applies it via set_model", async () => {
    await sendHello();
    act(() => chip().click());
    expect($$("[aria-label^='Effort ']").length).toBe(6);
    act(() => $("[aria-label='Effort high']")!.click());
    await flush();
    expect(setModel).toHaveBeenCalledWith({ chatId: chatId(), model: null, effort: "high" });
    await choose(/^Haiku$/);
    act(() => chip().click());
    expect($$("[aria-label^='Effort ']").length).toBe(0);
  });

  it("Set as default writes agent.model and agent.effort", async () => {
    await choose(/^Sonnet$/);
    act(() => chip().click());
    act(() =>
      $$("[role=menuitem]")
        .find((b) => b.textContent === "Set as default")!
        .click(),
    );
    await flush();
    expect(setSetting).toHaveBeenCalledWith("agent.model", "sonnet");
    expect(setSetting).toHaveBeenCalledWith("agent.effort", "default");
  });

  it("keeps the picked model through the send, the running turn and the next send", async () => {
    await sendHello();
    const id = chatId();
    // an earlier turn reported Sonnet
    act(() =>
      useAgentStore.getState().ingest(
        id,
        [
          {
            type: "usage",
            scope: "turn",
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            costUsd: null,
            contextWindow: null,
            model: "claude-sonnet-5-5",
          },
        ],
        useAgentStore.getState().chats[id]!.lastSeq + 1,
      ),
    );
    expect(chip().textContent).toContain("Sonnet 5.5");
    await choose(/^Opus$/);
    expect(chip().textContent).toContain("Opus");
    // the CLI confirms the switch without a turn report: the stale Sonnet report must not return
    act(() =>
      useAgentStore.setState((s) => ({
        modelPending: { ...s.modelPending, [id]: undefined } as never,
      })),
    );
    act(() =>
      useAgentStore.setState((s) => {
        const { [id]: _p, ...rest } = s.modelPending;
        return { modelPending: rest };
      }),
    );
    expect(chip().textContent).toContain("Opus");
    expect(chip().textContent).not.toContain("Sonnet");
    expect(chip().hasAttribute("data-pending")).toBe(false);
    await sendHello(); // the mock CLI then reports its own model: that one may show, the pick stays
    expect(useAgentStore.getState().chatModels[id]!.model).toBe("opus");
  });

  it("picking a model after a finished turn on an ended session shows it, not the old report", async () => {
    await sendHello();
    const id = chatId();
    act(() =>
      useAgentStore.setState((s) => ({
        chats: {
          ...s.chats,
          [id]: {
            ...s.chats[id]!,
            reportedModel: "claude-sonnet-5-5",
            session: null,
            state: "idle",
          },
        },
      })),
    );
    await choose(/^Opus$/);
    expect(chip().textContent).toContain("Opus");
    expect(chip().textContent).not.toContain("Sonnet");
    await sendHello();
    expect(start.mock.calls.at(-1)![0].settings.model).toBe("opus");
  });

  it("the permission mode stays on the pick through a send", async () => {
    await sendHello();
    await act(async () => await useAgentStore.getState().setPermissionMode("plan"));
    await sendHello();
    expect(useAgentStore.getState().modes[chatId()]).toBe("plan");
  });

  it("a chat without its own choice follows the agent.model setting", () => {
    act(() => useSettingsStore.setState({ settings: { "agent.model": "opus" } } as never));
    expect(chip().textContent).toContain("Opus");
  });
});
