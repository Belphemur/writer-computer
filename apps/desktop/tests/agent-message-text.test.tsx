// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const open = vi.hoisted(() => vi.fn());
vi.mock("../src/components/agent/agent-links", () => ({ openVaultPath: open }));

import { UserTurnCard } from "../src/components/agent/user-turn-card";
import type { ContextRef } from "../src/lib/agent/events";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("user message tokens", () => {
  let container: HTMLElement;
  let root: Root;
  beforeEach(() => {
    open.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });
  const render = (text: string, context: ContextRef[]) =>
    act(() =>
      root.render(<UserTurnCard message={{ messageId: "m", text, context, ts: 0 } as never} />),
    );
  const tokens = () => [...container.querySelectorAll<HTMLElement>("[data-agent-token]")];

  it("styles @refs and /skills inline, keeps the typed text, opens notes on click", () => {
    render(
      'compare @Projects/Plan.md with @activenote and @Docs and @"My Plan.md" then /summarize',
      [
        { kind: "active-note", path: "Notes/Today.md", inline: false },
        { kind: "note", path: "Projects/Plan.md" },
        { kind: "folder", path: "Docs" },
        { kind: "note", path: "My Plan.md" },
      ],
    );
    expect(tokens().map((t) => [t.dataset.agentToken, t.textContent])).toEqual([
      ["mention", "@Projects/Plan.md"],
      ["mention", "@activenote"],
      ["mention", "@Docs"],
      ["mention", '@"My Plan.md"'],
      ["skill", "/summarize"],
    ]);
    expect(container.querySelector("p")!.textContent).toBe(
      'compare @Projects/Plan.md with @activenote and @Docs and @"My Plan.md" then /summarize',
    );
    act(() => tokens()[0]!.click());
    expect(open).toHaveBeenLastCalledWith("Projects/Plan.md");
    act(() => tokens()[1]!.click());
    expect(open).toHaveBeenLastCalledWith("Notes/Today.md");
    act(() => tokens()[3]!.click());
    expect(open).toHaveBeenLastCalledWith("My Plan.md");
    expect(tokens()[2]!.tagName).toBe("SPAN"); // a folder is not a button
    expect(tokens()[4]!.tagName).toBe("SPAN");
  });

  it("shows the readable name with the full path as tooltip and opens that path", () => {
    const path = "Management/2026-11-16 - Daniel Plan.md";
    render('prep @"Daniel Plan"', [{ kind: "note", path, label: "Daniel Plan" }]);
    const t = tokens()[0]!;
    expect(t.textContent).toBe('@"Daniel Plan"');
    expect(t.title).toBe(path);
    act(() => t.click());
    expect(open).toHaveBeenLastCalledWith(path);
  });

  it("leaves @activenote inert when the note it meant is unknown (a reopened chat)", () => {
    render("see @activenote", []);
    expect(tokens()[0]!.tagName).toBe("SPAN");
  });
});
