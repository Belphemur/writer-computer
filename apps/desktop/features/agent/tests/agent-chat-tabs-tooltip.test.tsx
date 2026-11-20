// Agent chat tabs: the hover tooltip carries the full chat title (and its project) when the label
// is truncated, nothing otherwise.
// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }));
vi.mock("@features/agent/web/hooks/agent-api", () => ({
  closeAgentChat: vi.fn(),
  selectAgentChat: vi.fn(),
  startNewAgentChat: vi.fn(),
}));
vi.mock("@features/agent/web/hooks/use-agent", () => ({
  useActiveChatId: () => "c1",
  useAgentChatIds: () => ["c1"],
  useChatState: () => "idle",
  useChatTitle: () => "A very long chat title about the quarterly plan",
  useChatProjectPath: () => "/ws/Projects/Atlas",
}));
vi.mock("@features/agent/web/components/project-icon", () => ({ ProjectPathIcon: () => null }));

import { ChatTabs } from "@features/agent/web/components/chat-tabs";
import { TOOLTIP_DELAY_MS } from "@/components/hover-tooltip";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount(truncated: boolean) {
  vi.useFakeTimers();
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(() => 200);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() =>
    truncated ? 100 : 200,
  );
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(createElement(ChatTabs)));
  const tab = host.querySelector<HTMLElement>("[role=tab]")!;
  act(() => void tab.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })));
  act(() => void vi.advanceTimersByTime(TOOLTIP_DELAY_MS));
  const done = () => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  };
  return { tab, done };
}

describe("agent chat tab tooltip", () => {
  it("shows the full title and the project name when truncated", () => {
    vi.setSystemTime(3_000_000);
    const { tab, done } = mount(true);
    const tip = document.querySelector("[role=tooltip]");
    expect(tip?.textContent).toContain("A very long chat title about the quarterly plan");
    expect(tip?.textContent).toContain("Atlas");
    expect(tab.getAttribute("aria-describedby")).toBe(tip!.id);
    expect(tab.hasAttribute("title")).toBe(false);
    done();
  });

  it("shows none when the title fits", () => {
    vi.setSystemTime(4_000_000);
    const { done } = mount(false);
    expect(document.querySelector("[role=tooltip]")).toBeNull();
    done();
  });
});
