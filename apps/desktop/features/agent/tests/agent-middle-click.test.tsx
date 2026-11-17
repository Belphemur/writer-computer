// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({
  navigate: vi.fn(),
  newTab: vi.fn(),
  openUrl: vi.fn(),
  resolve: vi.fn(async (): Promise<string | null> => "/v/Notes/Plan.md"),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: h.openUrl }));
vi.mock("@/hooks/editor-api", () => ({
  navigateToFile: h.navigate,
  openFileInNewTab: h.newTab,
  getActiveFilePath: () => "/v/Today.md",
}));
vi.mock("@/hooks/workspace-api", () => ({ getWorkspaceRoot: () => "/v" }));
vi.mock("@/lib/tauri", () => ({ resolveWikiLinkTarget: h.resolve }));

import { AssistantText } from "@features/agent/web/components/assistant-text";
import { vaultLinkHandlers } from "@features/agent/web/components/agent-links";
import { MessageText } from "@features/agent/web/components/message-text";
import type { TextBlock } from "@features/agent/web/lib/transcript";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("middle-click on agent pane links", () => {
  let container: HTMLElement;
  let root: Root;
  beforeEach(() => {
    Object.values(h).forEach((m) => m.mockClear());
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const mouse = (el: Element, type: string, button: number) => {
    const e = new MouseEvent(type, { bubbles: true, cancelable: true, button });
    act(() => void el.dispatchEvent(e));
    return e;
  };
  const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
  const block = (text: string): TextBlock => ({
    kind: "text",
    id: "text:m:0",
    messageId: "m",
    blockIndex: 0,
    text,
    final: true,
  });

  it("assistant wiki links open in a new tab; left click keeps the current tab", async () => {
    act(() => root.render(<AssistantText block={block("See [[Plan]].")} />));
    const a = container.querySelector("a")!;
    expect(mouse(a, "mousedown", 1).defaultPrevented).toBe(true); // no autoscroll
    mouse(a, "auxclick", 1);
    await flush();
    expect(h.newTab).toHaveBeenLastCalledWith("/v/Notes/Plan.md", { activate: false });
    mouse(a, "click", 0);
    await flush();
    expect(h.navigate).toHaveBeenLastCalledWith("/v/Notes/Plan.md");
  });

  it("other buttons do nothing on auxclick", async () => {
    act(() => root.render(<AssistantText block={block("See [[Plan]].")} />));
    mouse(container.querySelector("a")!, "auxclick", 2);
    await flush();
    expect(h.newTab).not.toHaveBeenCalled();
    expect(h.navigate).not.toHaveBeenCalled();
  });

  it("external links open in the system browser on middle-click, never navigate", () => {
    act(() => root.render(<AssistantText block={block("[site](https://example.com/x)")} />));
    const a = container.querySelector("a")!;
    expect(mouse(a, "auxclick", 1).defaultPrevented).toBe(true);
    expect(h.openUrl).toHaveBeenCalledWith("https://example.com/x");
    expect(h.newTab).not.toHaveBeenCalled();
    expect(h.navigate).not.toHaveBeenCalled();
  });

  it("links in user messages and their pills open in a new tab", async () => {
    act(() =>
      root.render(
        <MessageText
          text="see @Projects/Plan.md and [[Plan]]"
          context={[{ kind: "note", path: "Projects/Plan.md" }]}
        />,
      ),
    );
    const pill = container.querySelector<HTMLElement>("[data-agent-token] , button")!;
    expect(mouse(pill, "mousedown", 1).defaultPrevented).toBe(true);
    mouse(pill, "auxclick", 1);
    expect(h.newTab).toHaveBeenLastCalledWith("/v/Projects/Plan.md", { activate: false });
    mouse(pill, "click", 0);
    expect(h.navigate).toHaveBeenLastCalledWith("/v/Projects/Plan.md");
    const a = container.querySelector("a");
    if (a) {
      mouse(a, "auxclick", 1);
      await flush();
      expect(h.newTab).toHaveBeenLastCalledWith("/v/Notes/Plan.md", { activate: false });
    }
  });

  it("vault paths (chips, file entries, attachments) open on button 1 and are confined", () => {
    act(() => root.render(<button type="button" {...vaultLinkHandlers("a/b.md")} />));
    const b = container.querySelector("button")!;
    mouse(b, "auxclick", 2);
    expect(h.newTab).not.toHaveBeenCalled();
    expect(mouse(b, "mousedown", 1).defaultPrevented).toBe(true);
    mouse(b, "auxclick", 1);
    expect(h.newTab).toHaveBeenLastCalledWith("/v/a/b.md", { activate: false });
    mouse(b, "click", 0);
    expect(h.navigate).toHaveBeenLastCalledWith("/v/a/b.md");

    expect(vaultLinkHandlers("../x.md")).toEqual({});
    expect(vaultLinkHandlers("/abs.md")).toEqual({});
  });
});
