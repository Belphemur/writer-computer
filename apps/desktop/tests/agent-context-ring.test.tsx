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
vi.mock("../src/lib/tauri", () => ({
  fuzzySearch: async () => [],
  resolveWikiLinkTarget: vi.fn(),
  recentLogErrors: vi.fn(async () => []),
  openLogFolder: vi.fn(),
}));

import { ContextRing } from "../src/components/agent/context-ring";
import { contextLevel, contextStatus, contextWindowFor } from "../src/lib/agent/context-usage";
import { appendUserTurn, createChat, reduceEvent } from "../src/lib/agent/reduce";
import type { AgentEvent } from "../src/lib/agent/events";
import type { Chat } from "../src/lib/agent/transcript";
import { useAgentStore } from "../src/stores/agent-store";
import { useSettingsStore } from "../src/stores/settings-store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const usage = (over: Partial<Extract<AgentEvent, { type: "usage" }>> = {}): AgentEvent => ({
  type: "usage",
  scope: "message",
  inputTokens: 2,
  outputTokens: 7,
  cacheReadTokens: 1000,
  cacheCreationTokens: 500,
  costUsd: null,
  contextWindow: null,
  ...over,
});

describe("context-usage (pure)", () => {
  it("looks up windows: 1m variants, the known table, unknown", () => {
    expect(contextWindowFor("opus[1m]")).toBe(1_000_000);
    expect(contextWindowFor("claude-opus-5-5[1m]")).toBe(1_000_000);
    expect(contextWindowFor("claude-sonnet-5-5")).toBe(1_000_000);
    expect(contextWindowFor("opus")).toBeNull();
    expect(contextWindowFor("my/custom")).toBeNull();
    expect(contextWindowFor(null)).toBeNull();
  });

  it("levels: muted below 60, warn to 85, danger above", () => {
    expect(contextLevel(null)).toBe("ok");
    expect(contextLevel(59.9)).toBe("ok");
    expect(contextLevel(60)).toBe("warn");
    expect(contextLevel(85)).toBe("warn");
    expect(contextLevel(85.1)).toBe("danger");
  });

  it("computes the percent from the reported window, else the model, else stays unknown", () => {
    const base = createChat("c");
    const withUsage = reduceEvent(
      base,
      usage({ inputTokens: 10, cacheReadTokens: 41_990, cacheCreationTokens: 0 }),
      0,
    );
    expect(contextStatus({ ...withUsage, contextWindow: 200_000 })).toMatchObject({
      used: 42_000,
      window: 200_000,
      percent: 21,
      level: "ok",
    });
    expect(contextStatus(withUsage, "opus[1m]")).toMatchObject({ window: 1_000_000, percent: 4 });
    expect(contextStatus(withUsage, "opus")).toMatchObject({
      used: 42_000,
      window: null,
      percent: null,
      fraction: null,
    });
    expect(contextStatus(base)).toMatchObject({ used: null, percent: null });
    expect(contextStatus({ ...withUsage, contextWindow: 100 }).percent).toBe(100);
  });
});

describe("the store keeps the context live", () => {
  it("updates from message usage, keeps per-call numbers over the turn's sum, resets on a new chat", () => {
    let chat = appendUserTurn(createChat("c"), { messageId: "u", text: "x", context: [] }, 0, true);
    chat = reduceEvent(chat, usage({ cacheReadTokens: 1000, cacheCreationTokens: 500 }), 0);
    expect(chat.contextUsage).toMatchObject({ cacheReadTokens: 1000, outputTokens: 7 });
    chat = reduceEvent(chat, usage({ cacheReadTokens: 3000, cacheCreationTokens: 0 }), 0);
    expect(chat.contextUsage?.cacheReadTokens).toBe(3000);
    // A message without input tokens never zeroes the ring.
    chat = reduceEvent(
      chat,
      usage({ inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 9 }),
      0,
    );
    expect(chat.contextUsage?.cacheReadTokens).toBe(3000);
    // The turn result sums every call of the turn: it must not replace the per-call numbers.
    chat = reduceEvent(
      chat,
      usage({ scope: "turn", cacheReadTokens: 9000, contextWindow: 200_000, costUsd: 0.1 }),
      0,
    );
    expect(chat.contextUsage?.cacheReadTokens).toBe(3000);
    expect(chat.contextWindow).toBe(200_000);
  });

  it("falls back to the turn usage when the stream gave none per call", () => {
    let chat = appendUserTurn(createChat("c"), { messageId: "u", text: "x", context: [] }, 0, true);
    chat = reduceEvent(chat, usage({ scope: "turn", cacheReadTokens: 9000 }), 0);
    expect(chat.contextUsage?.cacheReadTokens).toBe(9000);
  });

  it("starts empty on a new chat", () => {
    const id = useAgentStore.getState().newChat();
    expect(useAgentStore.getState().chats[id]!.contextUsage).toBeNull();
  });
});

describe("ContextRing", () => {
  let container: HTMLElement;
  let root: Root;
  const $ = (sel: string) => container.querySelector<HTMLElement>(sel);
  const flush = async () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

  const setChat = (chat: Chat) =>
    act(() => useAgentStore.setState({ chats: { c1: chat }, order: ["c1"], activeChatId: "c1" }));
  const chatWith = (tokens: number, window: number | null): Chat => ({
    ...createChat("c1"),
    contextWindow: window,
    contextUsage: {
      inputTokens: tokens,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 5,
      turnIndex: 0,
    },
  });
  const arc = () => $("[data-agent-context-arc]");
  const ring = () => $("[data-agent-context-ring]")!;

  beforeEach(async () => {
    useSettingsStore.setState({ settings: {} } as never);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    setChat(createChat("c1"));
    await act(async () => root.render(<ContextRing chatId="c1" />));
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("is empty with no usage and fills clockwise as tokens arrive", async () => {
    expect(ring().getAttribute("aria-label")).toBe("Context: no usage yet");
    expect(arc()).toBeNull();
    setChat(chatWith(42_000, 200_000));
    await flush();
    expect(ring().getAttribute("aria-label")).toBe("Context: 42k of 200k tokens (21%)");
    const bar = $("[role=progressbar]")!;
    expect(bar.getAttribute("aria-valuenow")).toBe("21");
    expect(bar.getAttribute("aria-valuemin")).toBe("0");
    expect(bar.getAttribute("aria-valuemax")).toBe("100");
    const c = Number(arc()!.getAttribute("stroke-dasharray"));
    expect(Number(arc()!.getAttribute("stroke-dashoffset"))).toBeCloseTo(c * (1 - 0.21), 3);
    expect(arc()!.getAttribute("transform")).toBe("rotate(-90 8 8)");
    expect(arc()!.getAttribute("class")).toContain("motion-reduce:transition-none");
  });

  it("colors by level", async () => {
    const level = async (tokens: number) => {
      setChat(chatWith(tokens, 100_000));
      await flush();
      return [ring().dataset.level, ring().className] as const;
    };
    expect((await level(59_000))[0]).toBe("ok");
    expect((await level(59_000))[1]).toContain("text-text-muted");
    expect((await level(70_000))[1]).toContain("var(--warning)");
    const [lv, cls] = await level(90_000);
    expect(lv).toBe("danger");
    expect(cls).toContain("var(--danger)");
  });

  it("is indeterminate (dashed, no percentage) when the window is unknown", async () => {
    setChat(chatWith(42_000, null));
    await flush();
    expect(arc()).toBeNull();
    expect(ring().getAttribute("aria-label")).toBe("Context: 42k tokens (window size unknown)");
    const bar = $("[role=progressbar]")!;
    expect(bar.hasAttribute("aria-valuenow")).toBe(false);
    expect($("circle")!.getAttribute("stroke-dasharray")).toBe("2 3");
  });

  it("opens a popover on click with the breakdown, the danger hint, and closes on Escape", async () => {
    setChat({
      ...chatWith(90_000, 100_000),
      contextUsage: {
        inputTokens: 2,
        cacheReadTokens: 80_000,
        cacheCreationTokens: 9_998,
        outputTokens: 321,
        turnIndex: 0,
      },
    });
    await flush();
    expect($("[data-agent-context-popover]")).toBeNull();
    act(() => ring().click());
    const pop = $("[data-agent-context-popover]")!;
    expect(ring().getAttribute("aria-expanded")).toBe("true");
    for (const t of ["Input", "Cache read", "Cache creation", "Output", "80k", "321"]) {
      expect(pop.textContent).toContain(t);
    }
    expect(pop.textContent).toContain("Consider starting a new chat or compacting.");
    act(() => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect($("[data-agent-context-popover]")).toBeNull();
  });

  it("shows no compaction hint below 85%", async () => {
    setChat(chatWith(50_000, 100_000));
    await flush();
    act(() => ring().click());
    expect($("[data-agent-context-popover]")!.textContent).not.toContain("Consider starting");
  });
});
