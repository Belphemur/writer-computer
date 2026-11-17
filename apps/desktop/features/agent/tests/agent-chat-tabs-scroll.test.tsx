// A chat that becomes active scrolls its tab into view through the shared strip logic.
// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({ active: "c2" }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }));
vi.mock("@features/agent/web/hooks/agent-api", () => ({
  closeAgentChat: vi.fn(),
  selectAgentChat: vi.fn(),
  startNewAgentChat: vi.fn(),
}));
vi.mock("@features/agent/web/hooks/use-agent", () => ({
  useActiveChatId: () => h.active,
  useAgentChatIds: () => ["c1", "c2"],
  useChatState: () => "idle",
  useChatTitle: (id: string) => id,
}));

import { ChatTabs } from "@features/agent/web/components/chat-tabs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("ChatTabs scroll", () => {
  it("scrolls an active tab beyond the visible width by the hidden amount", () => {
    const rect = (left: number, right: number) => () =>
      ({ left, right, top: 0, bottom: 0, width: right - left, height: 0 }) as DOMRect;
    const spy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        if (this.hasAttribute("data-tab-scroll")) return rect(0, 200)();
        if (this.id === "agent-tab-c2") return rect(180, 260)();
        return rect(0, 100)();
      });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => root.render(createElement(ChatTabs)));
    expect(host.querySelector<HTMLElement>("[data-tab-scroll]")!.scrollLeft).toBe(60);
    act(() => root.unmount());
    spy.mockRestore();
    host.remove();
  });
});
