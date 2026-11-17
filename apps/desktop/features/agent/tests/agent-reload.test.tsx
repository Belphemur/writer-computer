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

import { McpSection, SkillsChip } from "@features/agent/web/components/skills-chip";
import { createMockAgentClient, type Goldens } from "@features/agent/web/lib/mock-client";
import { appendUserTurn, createChat, reduceEvent } from "@features/agent/web/lib/reduce";
import {
  RELOAD_BUSY_TEXT,
  RELOAD_NOT_STARTED_TEXT,
  reloadNoticeFor,
} from "@features/agent/web/lib/session-reload";
import type { AgentEvent } from "@features/agent/web/lib/events";
import { parseWriterCommand } from "@features/agent/web/lib/writer-commands";
import {
  configureAgentRuntimeForTests,
  reloadChatSession,
  useAgentStore,
} from "@features/agent/web/stores/agent-store";
import { goldens } from "@features/agent/tests/helpers/agent-goldens";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const started = (mcpServers: { name: string; status: string }[]): AgentEvent => ({
  type: "session-started",
  sessionId: "s",
  model: null,
  cwd: "/v",
  permissionMode: null,
  tools: [],
  slashCommands: [],
  skills: [],
  mcpServers,
  cliVersion: null,
});

describe("the reducer", () => {
  it("keeps the MCP servers of the latest init and forgets them on a reload", () => {
    let chat = reduceEvent(createChat("c"), started([{ name: "notes", status: "failed" }]));
    expect(chat.session!.mcpServers).toEqual([{ name: "notes", status: "failed" }]);
    chat = reduceEvent(chat, { type: "session-reloaded", reason: null });
    expect(chat.session!.mcpServers).toBeNull();
    chat = reduceEvent(chat, started([{ name: "notes", status: "connected" }]));
    expect(chat.session!.mcpServers).toEqual([{ name: "notes", status: "connected" }]);
  });

  it("shows a transient notice, with the cause for an automatic reload, and never a turn", () => {
    const base = reduceEvent(createChat("c"), started([]));
    const manual = reduceEvent(base, { type: "session-reloaded", reason: null });
    expect(manual.localNotice).toBe("Session reloaded");
    const auto = reduceEvent(base, {
      type: "session-reloaded",
      reason: "skill writer-graph changed",
    });
    expect(auto.localNotice).toBe("Session reloaded: skill writer-graph changed");
    const mcp = reduceEvent(base, {
      type: "session-reloaded",
      reason: "MCP server github connected",
    });
    expect(mcp.localNotice).toBe("Session reloaded: MCP server github connected");
    expect(auto.turns).toEqual([]);
  });

  it("the next message clears the notice", () => {
    const chat = reduceEvent(createChat("c"), { type: "session-reloaded", reason: null });
    const next = appendUserTurn(chat, { messageId: "u", text: "x", context: [] }, 0, true);
    expect(next.localNotice).toBeNull();
  });

  it("a reload before any session leaves the chat without one", () => {
    const chat = reduceEvent(createChat("c"), { type: "session-reloaded", reason: null });
    expect(chat.session).toBeNull();
  });
});

describe("/reload", () => {
  const ctx = (outcome: string | null) => ({
    chatId: "c",
    chat: createChat("c"),
    args: "",
    regenerateTitle: vi.fn(),
    reloadSession: vi.fn(async () => outcome),
  });

  it("is a Writer command, so it never reaches Claude", () => {
    expect(parseWriterCommand("/reload")?.command.name).toBe("reload");
    expect(parseWriterCommand("/RELOAD now")?.args).toBe("now");
  });

  it("runs the store's reload; a started reload leaves the notice to its event", async () => {
    const c = ctx(null);
    expect(await parseWriterCommand("/reload")!.command.run(c)).toBeNull();
    expect(c.reloadSession).toHaveBeenCalledWith("c");
  });

  it("returns the refusal text when the chat is busy", async () => {
    const c = ctx(RELOAD_BUSY_TEXT);
    expect(await parseWriterCommand("/reload")!.command.run(c)).toBe(RELOAD_BUSY_TEXT);
  });
});

describe("reloadChatSession", () => {
  const mock = () => createMockAgentClient({ goldens: goldens as unknown as Goldens });

  beforeEach(() => {
    useAgentStore.setState({ chats: {}, order: [], activeChatId: null });
  });
  afterEach(() => configureAgentRuntimeForTests(null));

  const withChat = (session: boolean, state: "idle" | "ended" = "idle") => {
    const chat = {
      ...createChat("c1"),
      state,
      session: session
        ? {
            ...reduceEvent(createChat("c1"), started([])).session!,
          }
        : null,
    };
    useAgentStore.setState({ chats: { c1: chat }, order: ["c1"], activeChatId: "c1" });
  };

  it("a chat that never started has nothing to reload and the CLI is not asked", async () => {
    const reload = vi.fn(async () => "started" as const);
    configureAgentRuntimeForTests({ ...mock(), reload });
    withChat(false);
    expect(await reloadChatSession("c1")).toBe(RELOAD_NOT_STARTED_TEXT);
    expect(reload).not.toHaveBeenCalled();
  });

  it("asks Rust; started is silent, busy is the refusal text", async () => {
    const reload = vi.fn(async () => "started" as const);
    configureAgentRuntimeForTests({ ...mock(), reload });
    withChat(true);
    expect(await reloadChatSession("c1")).toBeNull();
    expect(reload).toHaveBeenCalledWith({ chatId: "c1" });
    reload.mockResolvedValueOnce("busy" as never);
    expect(await reloadChatSession("c1")).toBe(RELOAD_BUSY_TEXT);
    expect(reloadNoticeFor("busy")).toBe(RELOAD_BUSY_TEXT);
    expect(reloadNoticeFor("started")).toBeNull();
  });

  it("a failing call is a notice, not a throw", async () => {
    configureAgentRuntimeForTests({
      ...mock(),
      reload: async () => {
        throw new Error("boom");
      },
    });
    withChat(true);
    expect(await reloadChatSession("c1")).toBe("Could not reload the session: boom");
  });

  it("the store action shows the refusal as the chat's notice", async () => {
    configureAgentRuntimeForTests({ ...mock(), reload: async () => "busy" });
    withChat(true);
    await act(async () => await useAgentStore.getState().reloadSession());
    expect(useAgentStore.getState().chats.c1!.localNotice).toBe(RELOAD_BUSY_TEXT);
  });
});

describe("the MCP status display", () => {
  let container: HTMLElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("lists each server with its state, and warns on the chip when one is down", async () => {
    const chat = reduceEvent(
      createChat("c"),
      started([
        { name: "notes", status: "connected" },
        { name: "web", status: "needs-auth" },
      ]),
    );
    await act(async () => root.render(<SkillsChip chat={chat} />));
    expect(container.querySelector("[data-agent-skills-chip]")!.textContent).toContain("⚠");
    act(() => container.querySelector<HTMLElement>("[data-agent-skills-chip]")!.click());
    const rows = [...container.querySelectorAll("[data-agent-mcp-row]")].map((r) => r.textContent);
    expect(rows).toEqual(["notesconnected", "webneeds sign-in"]);
  });

  it("after a reload it says the status comes with the next message, then shows the new one", async () => {
    await act(async () => root.render(<McpSection servers={null} />));
    expect(container.querySelector("[data-agent-mcp-pending]")!.textContent).toBe(
      "Status appears with your next message.",
    );
    await act(async () =>
      root.render(<McpSection servers={[{ name: "n", status: "connected" }]} />),
    );
    expect(container.querySelector("[data-agent-mcp-pending]")).toBeNull();
    expect(container.querySelector("[data-agent-mcp-row]")!.textContent).toBe("nconnected");
    await act(async () => root.render(<McpSection servers={[]} />));
    expect(container.textContent).toContain("None reported");
  });
});
