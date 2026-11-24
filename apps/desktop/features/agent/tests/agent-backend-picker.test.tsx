// @vitest-environment jsdom
// The new-chat backend picker: hidden while one backend is usable, shown with two, selecting sets
// the chat's backend (and its note's), `agent.default-backend` decides a new chat's backend, and an
// unusable default falls back to Claude.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({ get: async () => undefined, set: async () => {} })),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(async () => true), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));

import { EmptyState } from "@features/agent/web/components/empty-state";
import { listBackends } from "@features/agent/web/lib/backends";
import {
  detectUsableBackends,
  resetBackendUsabilityForTests,
  resolveDefaultBackend,
  useBackendUsability,
} from "@features/agent/web/stores/backend-usability";
import {
  configureAgentRuntimeForTests,
  useAgentStore,
} from "@features/agent/web/stores/agent-store";
import { createMockAgentClient, type Goldens } from "@features/agent/web/lib/mock-client";
import { goldens } from "@features/agent/tests/helpers/agent-goldens";
import { useSettingsStore } from "@/stores/settings-store";
import { FIXTURE_ID, registerFixtureBackend } from "./helpers/fixture-backend";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const get = () => useAgentStore.getState();
const setUsable = (usable: Record<string, boolean>) => useBackendUsability.setState({ usable });

describe("the new-chat backend picker", () => {
  let container: HTMLElement;
  let root: Root;
  let unregister: () => void;
  const q = (sel: string) => container.querySelector<HTMLElement>(sel);
  const options = () =>
    [...container.querySelectorAll<HTMLElement>("[data-agent-backend-option]")].map(
      (o) => o.dataset.agentBackendOption,
    );

  async function mount() {
    await act(async () => root.render(<EmptyState chatId={get().activeChatId!} />));
  }

  beforeEach(() => {
    configureAgentRuntimeForTests(
      createMockAgentClient({ goldens: goldens as unknown as Goldens }),
    );
    useSettingsStore.setState({ settings: {} });
    useAgentStore.setState(useAgentStore.getInitialState(), true);
    resetBackendUsabilityForTests();
    unregister = registerFixtureBackend();
    get().newChat();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    unregister();
  });

  it("is hidden while only Claude is usable (no change for a Claude-only user)", async () => {
    setUsable({ claude: true, [FIXTURE_ID]: false });
    await mount();
    expect(q("[data-agent-backend-picker]")).toBeNull();
    // with the feature off there is nothing to pick from at all
    unregister();
    setUsable({ claude: true });
    await mount();
    expect(q("[data-agent-backend-picker]")).toBeNull();
  });

  it("is hidden until detection has run", async () => {
    await mount();
    expect(q("[data-agent-backend-picker]")).toBeNull();
  });

  it("is shown with two usable backends, in registry order, Claude's selected first", async () => {
    setUsable({ claude: true, [FIXTURE_ID]: true });
    await mount();
    expect(options()).toEqual(["claude", FIXTURE_ID]);
    expect(q("[data-agent-backend-option=claude]")?.getAttribute("aria-checked")).toBe("true");
  });

  it("selecting a backend sets the chat's backend and its note's, and drops a model picked for the other", async () => {
    setUsable({ claude: true, [FIXTURE_ID]: true });
    const id = get().activeChatId!;
    useAgentStore.setState((s) => ({
      chatModels: { ...s.chatModels, [id]: { model: "opus", effort: null } },
    }));
    await mount();
    await act(async () => q(`[data-agent-backend-option=${FIXTURE_ID}]`)!.click());
    expect(get().chats[id]!.backendId).toBe(FIXTURE_ID);
    expect(get().notes[id]!.meta.backend).toBe(FIXTURE_ID);
    // a chat id that is not the backend's session id: nothing to resume
    expect(get().notes[id]!.meta.sessionId).toBeNull();
    expect(get().chatModels[id]).toBeUndefined();
    expect(q(`[data-agent-backend-option=${FIXTURE_ID}]`)?.getAttribute("aria-checked")).toBe(
      "true",
    );
    await act(async () => q("[data-agent-backend-option=claude]")!.click());
    expect(get().chats[id]!.backendId).toBe("claude");
    expect(get().notes[id]!.meta.sessionId).toBe(id);
  });

  it("a chat that has content keeps its backend", async () => {
    setUsable({ claude: true, [FIXTURE_ID]: true });
    const id = get().activeChatId!;
    get().setDraft(id, { text: "half-written" });
    get().setChatBackend(id, FIXTURE_ID);
    expect(get().chats[id]!.backendId).toBe("claude");
  });

  it("detects each available backend once and caches it for the session", async () => {
    const detect = vi.fn(async () => ({ found: true, path: "/p", version: "1.0.0" }));
    unregister();
    unregister = registerFixtureBackend({ detect });
    expect(listBackends().map((b) => b.id)).toContain(FIXTURE_ID);
    // Claude's detection goes through the agent command; the mocked invoke answers nothing (not usable)
    await detectUsableBackends();
    expect(detect).toHaveBeenCalledTimes(1);
    expect(useBackendUsability.getState().usable[FIXTURE_ID]).toBe(true);
    await detectUsableBackends();
    expect(detect).toHaveBeenCalledTimes(1);
  });

  describe("the default backend", () => {
    const newChatBackend = () => {
      const id = get().newChat();
      return get().chats[id]!.backendId;
    };

    it("a new chat starts on agent.default-backend when that backend is usable", () => {
      setUsable({ claude: true, [FIXTURE_ID]: true });
      useSettingsStore.setState({ settings: { "agent.default-backend": FIXTURE_ID } });
      expect(newChatBackend()).toBe(FIXTURE_ID);
      expect(get().notes[get().activeChatId!]!.meta.backend).toBe(FIXTURE_ID);
    });

    it("falls back to Claude when the default was found missing, or its feature is off", () => {
      useSettingsStore.setState({ settings: { "agent.default-backend": FIXTURE_ID } });
      setUsable({ claude: true, [FIXTURE_ID]: false });
      expect(newChatBackend()).toBe("claude");
      unregister();
      setUsable({ claude: true });
      expect(newChatBackend()).toBe("claude");
    });

    it("is Claude without the setting, and for an unknown id", () => {
      expect(newChatBackend()).toBe("claude");
      const backends = listBackends();
      expect(resolveDefaultBackend("nope", backends, {})).toBe("claude");
      expect(resolveDefaultBackend(undefined, backends, {})).toBe("claude");
      // a "coming soon" backend is never a default
      expect(resolveDefaultBackend("codex", backends, { codex: true })).toBe("claude");
    });
  });
});
