// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({ get: async () => undefined, set: async () => {} })),
}));

import type { AgentClient } from "../src/lib/agent/client";
import { createMockAgentClient, type Goldens } from "../src/lib/agent/mock-client";
import {
  classifyStartError,
  configureAgentRuntimeForTests,
  toVaultRelative,
  useAgentStore,
} from "../src/stores/agent-store";
import { goldens } from "./helpers/agent-goldens";

const g = goldens as unknown as Goldens;
const get = () => useAgentStore.getState();
const chat = () => get().chats[get().activeChatId!]!;
const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms));

let mock: ReturnType<typeof createMockAgentClient>;
beforeEach(() => {
  mock = createMockAgentClient({ goldens: g });
  configureAgentRuntimeForTests(mock);
  useAgentStore.setState({
    chats: {},
    order: [],
    activeChatId: null,
    drafts: {},
    queued: {},
    modes: {},
    paneOpen: false,
    view: "chat",
    backend: "tauri",
    binary: null,
    currentProjectPath: null,
  });
});

describe("agent store: panes and tabs", () => {
  it("opening the pane creates a first chat and asks for composer focus", () => {
    const tick = get().focusComposerTick;
    get().openPane();
    expect(get().paneOpen).toBe(true);
    expect(get().order).toHaveLength(1);
    expect(get().focusComposerTick).toBeGreaterThan(tick);
    get().togglePane();
    expect(get().paneOpen).toBe(false);
    get().togglePane();
    expect(get().order).toHaveLength(1);
  });

  it("new chats take the current project; closing the last tab leaves a fresh one", () => {
    useAgentStore.setState({ currentProjectPath: "Projects/Demo" });
    const id = get().newChat();
    expect(get().chats[id]!.projectPath).toBe("Projects/Demo");
    get().closeChat(id);
    expect(get().order).toHaveLength(1);
    expect(get().activeChatId).toBe(get().order[0]);
  });

  it("cycles tabs and clamps the width", () => {
    const a = get().newChat();
    const b = get().newChat();
    expect(get().activeChatId).toBe(b);
    get().cycleChat(1);
    expect(get().activeChatId).toBe(a);
    get().cycleChat(-1);
    expect(get().activeChatId).toBe(b);
    get().setPaneWidth(5000);
    expect(get().paneWidth).toBe(900);
    get().setPaneWidth(10);
    expect(get().paneWidth).toBe(320);
  });
});

describe("agent store: a turn against the recorded backend", () => {
  it("send: optimistic user card, spawn, stream, complete, back to idle", async () => {
    get().openPane();
    const id = get().activeChatId!;
    const sent = get().sendMessage("hello there");
    expect(chat().turns[0]!.user?.text).toBe("hello there");
    expect(chat().state).toBe("starting");
    await sent;
    await mock.idle(id);
    await settle();
    expect(chat().state).toBe("idle");
    expect(chat().turns[0]!.status).toBe("completed");
    expect(chat().title).toBe("hello there");
    expect(chat().lastSeq).toBeGreaterThan(3);
    expect(get().drafts[id]!.text).toBe("");
  });

  it("a permission pauses the chat; Allow resumes it", async () => {
    get().openPane();
    const id = get().activeChatId!;
    await get().sendMessage("write a file");
    await vi.waitFor(() => expect(chat().state).toBe("awaiting-permission"));
    const req = chat().pendingPermissions[0]!;
    expect(req.tool).toBe("Write");
    await get().decidePermission(req.requestId, "allow");
    await vi.waitFor(() => expect(chat().pendingPermissions[0]?.tool).toBe("Bash"));
    await get().decidePermission(chat().pendingPermissions[0]!.requestId, "deny");
    await mock.idle(id);
    await settle();
    expect(chat().state).toBe("idle");
    expect(chat().turns[0]!.status).toBe("completed");
  });

  it("stop while a card is pending: cancelling, then the capture's interrupted ending", async () => {
    get().openPane();
    const id = get().activeChatId!;
    await get().sendMessage("stop");
    await vi.waitFor(() => expect(chat().state).toBe("awaiting-permission"));
    const stopping = get().stop();
    expect(chat().state).toBe("cancelling");
    await stopping;
    await mock.idle(id);
    await settle();
    expect(chat().state).toBe("idle");
    expect(chat().turns[0]!.status).toBe("interrupted");
  });

  it("a message sent while running is queued, merged, and sent when the turn ends", async () => {
    get().openPane();
    const id = get().activeChatId!;
    await get().sendMessage("write");
    await vi.waitFor(() => expect(chat().state).toBe("awaiting-permission"));
    await get().sendMessage("second");
    await get().sendMessage("third");
    expect(get().queued[id]!.text).toBe("second\n\nthird");
    expect(chat().turns).toHaveLength(1);
    // finish the first turn
    await get().decidePermission(chat().pendingPermissions[0]!.requestId, "allow");
    await vi.waitFor(() => expect(chat().pendingPermissions[0]?.tool).toBe("Bash"));
    await get().decidePermission(chat().pendingPermissions[0]!.requestId, "allow");
    await vi.waitFor(() => expect(chat().turns).toHaveLength(2));
    expect(chat().turns[1]!.user?.text).toBe("second\n\nthird");
    expect(get().queued[id]).toBeUndefined();
    await mock.idle(id);
  });

  it("removing the queued chip drops it", async () => {
    get().openPane();
    const id = get().activeChatId!;
    await get().sendMessage("write");
    await vi.waitFor(() => expect(chat().state).toBe("awaiting-permission"));
    await get().sendMessage("later");
    get().removeQueued(id);
    expect(get().queued[id]).toBeUndefined();
    await get().stop();
    await mock.idle(id);
  });

  it("the active-note chip and mentions travel as context and are consumed", async () => {
    get().openPane();
    const id = get().activeChatId!;
    const send = vi.spyOn(mock, "send");
    get().setDraft(id, {
      text: "x",
      mentions: [{ kind: "note", path: "a.md" }],
      activeNote: false,
    });
    await get().sendMessage("x");
    expect(send.mock.calls[0]![0].context).toEqual([{ kind: "note", path: "a.md" }]);
    expect(get().drafts[id]!.mentions).toEqual([]);
    await mock.idle(id);
  });

  it("passes the per-chat permission mode to the session start", async () => {
    get().openPane();
    const id = get().activeChatId!;
    const start = vi.spyOn(mock, "start");
    await get().setPermissionMode("plan");
    expect(get().modes[id]).toBe("plan");
    await get().sendMessage("hi");
    expect(start.mock.calls[0]![0].settings.permissionMode).toBe("plan");
    await mock.idle(id);
  });
});

describe("agent store: failures", () => {
  const failing = (error: unknown): AgentClient => ({
    ...createMockAgentClient({ goldens: g }),
    start: async () => {
      throw error;
    },
  });

  it("a denied or missing binary becomes an error state with a fix action, not a hang", async () => {
    configureAgentRuntimeForTests(failing({ kind: "binary-not-found", message: "no claude" }));
    get().openPane();
    await get().sendMessage("hi");
    expect(chat().state).toBe("error");
    expect(chat().error?.kind).toBe("binary-not-found");
    expect(chat().turns[0]!.status).toBe("error");
    // retry is only meaningful once the user fixed it; composer is disabled meanwhile
    await get().sendMessage("again");
    expect(chat().turns).toHaveLength(1);
  });

  it("classifies errors", () => {
    expect(classifyStartError("Spawn denied by the user").kind).toBe("spawn-denied");
    expect(classifyStartError(new Error("Command agent_start not found")).message).toMatch(
      /not available/,
    );
    expect(classifyStartError({ message: "boom" }).kind).toBe("spawn-failed");
  });

  it("retry resends the last user message after a retryable failure", async () => {
    let calls = 0;
    const base = createMockAgentClient({ goldens: g });
    configureAgentRuntimeForTests({
      ...base,
      start: async (a: Parameters<AgentClient["start"]>[0]) => {
        if (calls++ === 0) throw new Error("transient");
        return base.start(a);
      },
    });
    get().openPane();
    const id = get().activeChatId!;
    await get().sendMessage("try me");
    expect(chat().error?.kind).toBe("spawn-failed");
    await get().retry();
    await base.idle(id);
    await settle();
    expect(chat().turns).toHaveLength(2);
    expect(chat().turns[1]!.user?.text).toBe("try me");
    expect(chat().turns[1]!.status).toBe("completed");
  });
});

describe("paths", () => {
  it("makes vault-relative paths", () => {
    expect(toVaultRelative("/v/Notes/a.md", "/v")).toBe("Notes/a.md");
    expect(toVaultRelative("/other/a.md", "/v")).toBeNull();
    expect(toVaultRelative("/v2/a.md", "/v")).toBeNull();
    expect(toVaultRelative("/v/a.md", null)).toBeNull();
  });
});
