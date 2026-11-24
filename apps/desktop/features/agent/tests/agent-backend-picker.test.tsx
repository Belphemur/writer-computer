// @vitest-environment jsdom
// The harness chip in the composer: hidden while one backend is usable, shown with two, selecting
// sets the chat's backend (and its note's) until the first send, then it is locked and offers a
// new chat on the other backend, `agent.default-backend` decides a new chat's backend, and an
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

import { BackendChip } from "@features/agent/web/components/backend-chip";
import { listBackends } from "@features/agent/web/lib/backends";
import {
  detectUsableBackends,
  resetBackendUsabilityForTests,
  resolveDefaultBackend,
  useBackendUsability,
} from "@features/agent/web/stores/backend-usability";
import {
  configureAgentRuntimeForTests,
  hasChatStarted,
  reresolveUntouchedChats,
  useAgentStore,
} from "@features/agent/web/stores/agent-store";
import { createMockAgentClient, type Goldens } from "@features/agent/web/lib/mock-client";
import { goldens } from "@features/agent/tests/helpers/agent-goldens";
import { useSettingsStore } from "@/stores/settings-store";
import { FIXTURE_ID, registerFixtureBackend } from "./helpers/fixture-backend";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const get = () => useAgentStore.getState();
const setUsable = (usable: Record<string, boolean>) => useBackendUsability.setState({ usable });

describe("the harness chip", () => {
  let container: HTMLElement;
  let root: Root;
  let unregister: () => void;
  const q = (sel: string) => container.querySelector<HTMLElement>(sel);
  const options = () =>
    [...container.querySelectorAll<HTMLElement>("[data-agent-backend-option]")].map(
      (o) => o.dataset.agentBackendOption,
    );

  const openMenu = async () => act(async () => q("[data-agent-backend-chip]")!.click());

  async function mount() {
    await act(async () => root.render(<BackendChip chatId={get().activeChatId!} />));
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
    expect(q("[data-agent-backend-chip]")).toBeNull();
    // with the feature off there is nothing to pick from at all
    unregister();
    setUsable({ claude: true });
    await mount();
    expect(q("[data-agent-backend-chip]")).toBeNull();
  });

  it("is hidden until detection has run", async () => {
    await mount();
    expect(q("[data-agent-backend-chip]")).toBeNull();
  });

  it("is shown with two usable backends, in registry order, Claude's selected first", async () => {
    setUsable({ claude: true, [FIXTURE_ID]: true });
    await mount();
    await openMenu();
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
    await openMenu();
    await act(async () => q(`[data-agent-backend-option=${FIXTURE_ID}]`)!.click());
    expect(get().chats[id]!.backendId).toBe(FIXTURE_ID);
    expect(get().notes[id]!.meta.backend).toBe(FIXTURE_ID);
    // a chat id that is not the backend's session id: nothing to resume
    expect(get().notes[id]!.meta.sessionId).toBeNull();
    expect(get().chatModels[id]).toBeUndefined();
    await openMenu();
    expect(q(`[data-agent-backend-option=${FIXTURE_ID}]`)?.getAttribute("aria-checked")).toBe(
      "true",
    );
    await act(async () => q("[data-agent-backend-option=claude]")!.click());
    expect(get().chats[id]!.backendId).toBe("claude");
    expect(get().notes[id]!.meta.sessionId).toBe(id);
  });

  it("a draft does not lock the chat, a started chat keeps its backend", async () => {
    setUsable({ claude: true, [FIXTURE_ID]: true });
    const id = get().activeChatId!;
    get().setDraft(id, { text: "half-written" });
    get().setChatBackend(id, FIXTURE_ID);
    expect(get().chats[id]!.backendId).toBe(FIXTURE_ID);
    useAgentStore.setState((s) => ({
      chats: { ...s.chats, [id]: { ...s.chats[id]!, state: "running" } },
    }));
    get().setChatBackend(id, "claude");
    expect(get().chats[id]!.backendId).toBe(FIXTURE_ID);
  });

  it("after the first send the chip is locked and offers a new chat on the other backend", async () => {
    setUsable({ claude: true, [FIXTURE_ID]: true });
    const id = get().activeChatId!;
    useAgentStore.setState((s) => ({
      chats: { ...s.chats, [id]: { ...s.chats[id]!, state: "running" } },
    }));
    await mount();
    expect(q("[data-agent-backend-chip]")?.dataset.locked).toBe("true");
    await openMenu();
    expect(q("[data-agent-backend-option=claude]")?.hasAttribute("disabled")).toBe(true);
    expect(q("[data-agent-backend-option]:not([disabled])")).toBeNull();
    const fresh = q(`[data-agent-backend-new=${FIXTURE_ID}]`)!;
    // focus lands on the one enabled row, arrows stay on it, Esc gives focus back to the chip
    expect(document.activeElement).toBe(fresh);
    await act(async () => {
      fresh.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect(document.activeElement).toBe(fresh);
    await act(async () => {
      fresh.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(q("[role=menu]")).toBeNull();
    expect(document.activeElement).toBe(q("[data-agent-backend-chip]"));
    await openMenu();
    const again = q(`[data-agent-backend-new=${FIXTURE_ID}]`)!;
    expect(again.textContent).toMatch(/^New chat with /);
    await act(async () => again.click());
    const now = get().activeChatId!;
    expect(now).not.toBe(id);
    expect(get().chats[now]!.backendId).toBe(FIXTURE_ID);
    expect(get().chats[id]!.backendId).toBe("claude");
  });

  it("a chat that has only a session to resume is started", () => {
    const id = get().activeChatId!;
    const chat = get().chats[id]!;
    expect(hasChatStarted(chat)).toBe(false);
    expect(hasChatStarted({ ...chat, resumeSessionId: "sess-1" })).toBe(true);
    setUsable({ claude: true, [FIXTURE_ID]: true });
    useAgentStore.setState((s) => ({
      chats: { ...s.chats, [id]: { ...chat, resumeSessionId: "sess-1" } },
    }));
    get().setChatBackend(id, FIXTURE_ID);
    expect(get().chats[id]!.backendId).toBe("claude");
  });

  it("a chat that sent a message keeps its backend once it is idle again", async () => {
    setUsable({ claude: true, [FIXTURE_ID]: true });
    const id = get().activeChatId!;
    await get().sendMessage("hello there");
    await vi.waitFor(() => expect(get().chats[id]!.state).toBe("idle"));
    expect(get().chats[id]!.turns.length).toBeGreaterThan(0);
    expect(hasChatStarted(get().chats[id]!)).toBe(true);
    get().setChatBackend(id, FIXTURE_ID);
    expect(get().chats[id]!.backendId).toBe("claude");
    await mount();
    expect(q("[data-agent-backend-chip]")?.dataset.locked).toBe("true");
  });

  it("a new chat started on a backend keeps it when the default is re-resolved", () => {
    setUsable({ claude: true, [FIXTURE_ID]: true });
    useSettingsStore.setState({ settings: { "agent.default-backend": "claude" } });
    const picked = get().newChat(null, FIXTURE_ID);
    const unpicked = get().newChat();
    // the default moves to the other backend: an untouched chat follows it, a picked one stays
    useSettingsStore.setState({ settings: { "agent.default-backend": FIXTURE_ID } });
    reresolveUntouchedChats();
    expect(get().chats[picked]!.backendId).toBe(FIXTURE_ID);
    expect(get().chats[unpicked]!.backendId).toBe(FIXTURE_ID);
    useSettingsStore.setState({ settings: { "agent.default-backend": "claude" } });
    reresolveUntouchedChats();
    expect(get().chats[picked]!.backendId).toBe(FIXTURE_ID);
    expect(get().chats[unpicked]!.backendId).toBe("claude");
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
