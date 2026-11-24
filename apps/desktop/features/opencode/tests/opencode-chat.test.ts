// @vitest-environment jsdom
// An OpenCode chat through the neutral pane: the start carries the chat's backend and reads the
// program, model, effort and tier models from `agent.opencode.*` (never the Claude keys), the title
// call runs on the OpenCode cheap tier, a note keeps its backend and resumes by its own session id
// (`ses_...`, not a uuid), and a backend that is off answers with the Rust message as the error card.
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({ get: async () => undefined, set: async () => {} })),
}));

import { goldens } from "@features/agent/tests/helpers/agent-goldens";
import type { ChatHistoryClient } from "@features/agent/web/lib/chat-history-client";
import { chatFromNote } from "@features/agent/web/lib/chat-from-note";
import { parseChatNote } from "@features/agent/web/lib/chat-note";
import { buildNote, newNoteState } from "@features/agent/web/lib/chat-persist";
import type { AgentSettings, ChatSummary } from "@features/agent/web/lib/events";
import { createMockAgentClient, type Goldens } from "@features/agent/web/lib/mock-client";
import { createChat } from "@features/agent/web/lib/reduce";
import {
  configureAgentRuntimeForTests,
  configureChatPersistenceForTests,
  regenerateChatTitle,
  useAgentStore,
} from "@features/agent/web/stores/agent-store";
import { AGENT_PANE_DEFAULT_WIDTH, usePaneStore } from "@features/agent/web/stores/pane-store";
import { agentSettingsFrom } from "@features/agent/web/lib/agent-settings";
import { backendById } from "@features/agent/web/lib/backends";
import {
  resetBackendUsabilityForTests,
  useBackendUsability,
} from "@features/agent/web/stores/backend-usability";
import { featureHost } from "@/lib/features/registry";
import { useSettingsStore } from "@/stores/settings-store";
import opencodeFeature from "../web/index";

const get = () => useAgentStore.getState();
const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms));

const SETTINGS = {
  "agent.default-backend": "opencode",
  "agent.opencode.binary-path": "/synthetic/bin/opencode",
  "agent.opencode.model": "acme/big",
  "agent.opencode.effort": "high",
  "agent.opencode.model-cheap": "acme/small",
  "agent.opencode.model-standard": "",
  "agent.opencode.model-strong": "zed/strong",
  // Claude's own, which an OpenCode chat must never read
  "agent.binary-path": "/synthetic/bin/claude",
  "agent.model": "opus",
  "agent.effort": "low",
  "agent.claude.model-cheap": "haiku",
  "agent.claude.model-standard": "sonnet",
  "agent.claude.model-strong": "default",
};

const SUMMARY = { projectPath: null } as ChatSummary;

function history(over: Partial<ChatHistoryClient> = {}): ChatHistoryClient {
  return {
    list: vi.fn(async () => []),
    load: vi.fn(),
    save: vi.fn(async (a: { chatId: string }) => ({ ...SUMMARY, chatId: a.chatId })),
    action: vi.fn(async () => null),
    autoTitle: vi.fn(async () => null),
    regenerateTitle: vi.fn(async () => ({ status: "refused" as const, message: "no" })),
    replay: vi.fn(),
    saveImage: vi.fn(),
    importFile: vi.fn(),
    permissionRules: vi.fn(async () => ({ allow: [], deny: [] })),
    removePermissionRule: vi.fn(async () => {}),
    ...over,
  } as unknown as ChatHistoryClient;
}

describe("an OpenCode chat in the neutral pane", () => {
  let start: ReturnType<typeof vi.fn>;
  let mock: ReturnType<typeof createMockAgentClient>;

  beforeEach(() => {
    featureHost.register(opencodeFeature);
    mock = createMockAgentClient({ goldens: goldens as unknown as Goldens });
    start = vi.fn(mock.start);
    configureAgentRuntimeForTests({ ...mock, start } as typeof mock);
    configureChatPersistenceForTests({ history: history(), delayMs: 2, reload: async () => false });
    usePaneStore.setState({ open: false, width: AGENT_PANE_DEFAULT_WIDTH });
    useAgentStore.setState(useAgentStore.getInitialState(), true);
    useSettingsStore.setState({ settings: SETTINGS });
    // detection has found both programs: the default backend is usable
    resetBackendUsabilityForTests();
    useBackendUsability.setState({ usable: { claude: true, opencode: true } });
  });
  afterEach(async () => {
    await featureHost.unregister("opencode");
  });

  it("starts with the chat's backend and the OpenCode keys", async () => {
    get().openPane();
    const id = get().activeChatId!;
    expect(get().chats[id]!.backendId).toBe("opencode");
    expect(get().notes[id]!.meta.backend).toBe("opencode");
    await get().sendMessage("hello");
    await mock.idle(id);
    expect(start).toHaveBeenCalledTimes(1);
    const req = start.mock.calls[0]![0] as { backend: string; settings: AgentSettings };
    expect(req.backend).toBe("opencode");
    expect(req.settings).toMatchObject({
      binaryPath: "/synthetic/bin/opencode",
      model: "acme/big",
      effort: "high",
      tierModels: { cheap: "acme/small", standard: null, strong: "zed/strong" },
    });
  });

  it("a chat's own model choice wins over the setting, as for any backend", async () => {
    get().openPane();
    const id = get().activeChatId!;
    await get().setChatModel("zed/strong", "max");
    await get().sendMessage("hello");
    await mock.idle(id);
    const req = start.mock.calls[0]![0] as { settings: AgentSettings };
    expect(req.settings).toMatchObject({ model: "zed/strong", effort: "max" });
  });

  it("the title call runs on this backend's cheap tier, with the chat's own model beside it", async () => {
    const client = history();
    configureChatPersistenceForTests({ history: client, delayMs: 2, reload: async () => false });
    get().openPane();
    const id = get().activeChatId!;
    await regenerateChatTitle(id);
    expect(client.regenerateTitle).toHaveBeenCalledWith(id, "acme/small");
    // a blank cheap tier is passed as blank: Rust falls back to the chat's own model
    useSettingsStore.setState({ settings: { ...SETTINGS, "agent.opencode.model-cheap": "" } });
    await regenerateChatTitle(id);
    expect(client.regenerateTitle).toHaveBeenLastCalledWith(id, "");
  });

  it("the settings of a backend are read through its descriptor only", () => {
    const oc = backendById("opencode")!;
    expect(agentSettingsFrom(SETTINGS, oc).binaryPath).toBe("/synthetic/bin/opencode");
    expect(agentSettingsFrom(SETTINGS).binaryPath).toBe("/synthetic/bin/claude");
    expect(agentSettingsFrom(SETTINGS).tierModels.cheap).toBe("haiku");
  });

  it("its note keeps the backend; a session id that is not a uuid resumes as it is", () => {
    const now = 1;
    const fresh = createChat("c1", { backendId: "opencode" });
    const note = newNoteState("c1", null, now, "opencode");
    // never started: no session to resume (the chat id is not an OpenCode session id)
    const never = parseChatNote(buildNote(fresh, note, now, null).markdown);
    expect(never.meta.backend).toBe("opencode");
    expect(never.meta.sessionId).toBeNull();
    expect(chatFromNote(never, SUMMARY).resumeSessionId).toBeNull();
    expect(chatFromNote(never, SUMMARY).backendId).toBe("opencode");
    // started: the stored id comes back unchanged
    const started = { ...fresh, resumeSessionId: "ses_abc123" };
    const doc = parseChatNote(buildNote(started, note, now, null).markdown);
    expect(doc.meta.sessionId).toBe("ses_abc123");
    expect(chatFromNote(doc, SUMMARY).resumeSessionId).toBe("ses_abc123");
  });

  it("a Claude note without a session id still resumes by its chat id", () => {
    const note = newNoteState("c2", null, 1);
    expect(note.meta.backend).toBe("claude");
    expect(note.meta.sessionId).toBe("c2");
    const doc = parseChatNote(buildNote(createChat("c2"), note, 1, null).markdown);
    expect(chatFromNote(doc, SUMMARY).resumeSessionId).toBe("c2");
  });

  it("starting a chat whose backend is off shows Rust's message as the error card", async () => {
    get().openPane();
    const id = get().activeChatId!;
    // a chat with content keeps its backend when the feature goes off (an untouched one would move)
    get().setDraft(id, { text: "hello" });
    await featureHost.unregister("opencode");
    const message = "the opencode agent is not available: turn it on in Settings > Features";
    configureAgentRuntimeForTests({
      ...mock,
      start: async () => {
        throw { kind: "feature-unavailable", message };
      },
    } as typeof mock);
    await get().sendMessage("hello");
    await settle();
    const chat = get().chats[id]!;
    expect(chat.backendId).toBe("opencode");
    expect(chat.error?.message).toBe(message);
    expect(chat.state).not.toBe("idle");
  });
});
