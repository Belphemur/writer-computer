// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({ get: async () => undefined, set: async () => {} })),
}));

import { ThinkingRow } from "@features/agent/web/components/thinking-row";
import type { AgentEvent } from "@features/agent/web/lib/events";
import {
  appendUserTurn,
  createChat,
  reduceEvent,
  reduceEvents,
} from "@features/agent/web/lib/reduce";
import type { ThinkingBlock } from "@features/agent/web/lib/transcript";
import { useSettingsStore } from "@/stores/settings-store";
import { goldens } from "@features/agent/tests/helpers/agent-goldens";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const thinking = (phase: "start" | "delta" | "end", text = "", blockIndex = 0): AgentEvent => ({
  type: "thinking",
  messageId: "m",
  blockIndex,
  phase,
  text,
  estimatedTokens: null,
});

const start = () =>
  appendUserTurn(createChat("c"), { messageId: "u", text: "x", context: [] }, 0, true);
const blockOf = (chat: ReturnType<typeof start>) => chat.turns[0]!.blocks[0] as ThinkingBlock;

describe("the reducer keeps the reasoning text of a thinking block", () => {
  it("accumulates deltas, then the final text replaces them", () => {
    let chat = reduceEvents(start(), [
      thinking("start"),
      thinking("delta", "Checking the arithmet"),
      thinking("delta", "ic: 17 times 23"),
    ]);
    expect(blockOf(chat).text).toBe("Checking the arithmetic: 17 times 23");
    chat = reduceEvent(chat, thinking("end", "Checking the arithmetic: 17 times 23 is 391."));
    expect(blockOf(chat).text).toBe("Checking the arithmetic: 17 times 23 is 391.");
    expect(blockOf(chat).endedAt).not.toBeNull();
  });

  it("keeps the streamed text when the final block has none, and per block", () => {
    const chat = reduceEvents(start(), [
      thinking("start"),
      thinking("delta", "abc"),
      thinking("end", ""),
      thinking("start", "", 1),
      thinking("delta", "def", 1),
    ]);
    const [a, b] = chat.turns[0]!.blocks as ThinkingBlock[];
    expect([a!.text, b!.text]).toEqual(["abc", "def"]);
  });

  it("rebuilds the summary text from the real capture", () => {
    const chat = reduceEvents(start(), goldens["thinking-summary"]!);
    expect(blockOf(chat).text).toMatch(/^Checking the arithmetic: 17 times 23 breaks into/);
    expect(blockOf(chat).estimatedTokens).toBeGreaterThan(0);
  });

  it("has no text for redacted content, only the estimate", () => {
    const chat = reduceEvents(start(), goldens["thinking-redacted"]!);
    expect(blockOf(chat)).toMatchObject({ text: "" });
    expect(blockOf(chat).estimatedTokens).toBeGreaterThan(0);
    expect(blockOf(chat).endedAt).not.toBeNull();
  });
});

describe("ThinkingRow", () => {
  let container: HTMLElement;
  let root: Root;
  const render = (block: ThinkingBlock) => act(() => root.render(<ThinkingRow block={block} />));
  const toggle = () => act(() => container.querySelector("button")!.click());
  const body = () => container.querySelector("[data-agent-thinking-text]");
  const setShow = (on: boolean) =>
    act(() => useSettingsStore.setState({ settings: { "agent.show-thinking": on } } as never));
  const live = (text: string, endedAt: number | null = null): ThinkingBlock => ({
    kind: "thinking",
    id: "thinking:m:0",
    messageId: "m",
    blockIndex: 0,
    startedAt: 1000,
    endedAt,
    text,
    estimatedTokens: 1200,
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    useSettingsStore.setState({ settings: {} } as never);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows Thinking… then Thought for Ns, and the text streams in while open", () => {
    render(live("First **thought**"));
    expect(container.textContent).toContain("Thinking…");
    expect(body()).toBeNull(); // collapsed by default
    toggle();
    expect(body()!.querySelector("strong")!.textContent).toBe("thought");
    render(live("First **thought** and more"));
    expect(body()!.textContent).toContain("and more");
    expect(body()!.getAttribute("data-streaming")).toBe("true");
    render(live("First **thought** and more.", 6000));
    expect(container.textContent).toContain("Thought for 5s");
    expect(body()!.hasAttribute("data-streaming")).toBe(false);
    expect(body()!.textContent).toContain("and more.");
    toggle();
    expect(body()).toBeNull();
  });

  it("follows the stream to the bottom", () => {
    const view = { scrollHeight: 0 };
    // growth after React committed is followed by the content's resize observer, not by a render
    const callbacks: Array<() => void> = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: () => void) {
          callbacks.push(cb);
        }
        observe() {}
        disconnect() {}
      },
    );
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get: () => view.scrollHeight,
    });
    try {
      render(live("a"));
      toggle();
      view.scrollHeight = 500;
      act(() => callbacks.forEach((cb) => cb()));
      expect(body()!.scrollTop).toBe(500);
    } finally {
      vi.unstubAllGlobals();
      delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
    }
  });

  it("explains an empty summary instead of showing only the count", () => {
    render(live("", 6000));
    toggle();
    expect(body()).toBeNull();
    expect(container.textContent).toContain("The CLI sent no reasoning text for this step");
    expect(container.textContent).toContain("~1200 tokens of reasoning");
  });

  it("keeps today's summary when the setting is off", () => {
    setShow(false);
    render(live("secret summary", 6000));
    toggle();
    expect(body()).toBeNull();
    expect(container.textContent).not.toContain("secret summary");
    expect(container.textContent).toContain("~1200 tokens of reasoning");
    setShow(true);
    expect(body()!.textContent).toContain("secret summary");
  });
});
