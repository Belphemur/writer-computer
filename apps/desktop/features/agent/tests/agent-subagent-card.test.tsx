// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({ get: async () => undefined, set: async () => {} })),
}));

import { PermissionCard } from "@features/agent/web/components/permission-card";
import { Transcript } from "@features/agent/web/components/transcript";
import { TurnChangesCard } from "@features/agent/web/components/turn-changes-card";
import { createMockAgentClient, type Goldens } from "@features/agent/web/lib/mock-client";
import type { Chat, PermissionView, Turn } from "@features/agent/web/lib/transcript";
import { configureAgentRuntimeForTests } from "@features/agent/web/stores/agent-store";
import { useSettingsStore } from "@/stores/settings-store";
import { goldens } from "./helpers/agent-goldens";
import { chatAfter } from "./helpers/agent-subagents";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  useSettingsStore.setState({ settings: {} });
  configureAgentRuntimeForTests(createMockAgentClient({ goldens: goldens as unknown as Goldens }));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  configureAgentRuntimeForTests(null);
});

const $ = <T extends Element = HTMLElement>(sel: string, from: ParentNode = container) =>
  from.querySelector<T>(sel);
const $$ = (sel: string, from: ParentNode = container) => [
  ...from.querySelectorAll<HTMLElement>(sel),
];
const card = (id: string) => $(`[data-agent-subagent="${id}"]`)!;
const mount = async (chat: Chat) => act(async () => root.render(<Transcript chat={chat} />));
const headerOf = (c: HTMLElement) => c.querySelector<HTMLButtonElement>("button[aria-expanded]")!;

/** `subagent-parallel` cut just before the second sub-agent's edit result: both still run. */
const running = () =>
  chatAfter("subagent-parallel", {
    until: (e) => e.type === "tool-call-finished" && e.toolCallId === "toolu_w_edit",
  });
const finished = () => chatAfter("subagent-parallel");

describe("a sub-agent card", () => {
  it("says the role, the model, the task and the status in its header", async () => {
    await mount(finished());
    const ex = card("toolu_ex");
    expect($("[data-agent-subagent-role]", ex)!.textContent).toBe("Explorer");
    expect($("[data-agent-subagent-model]", ex)!.textContent).toBe("Haiku");
    expect($("[data-agent-subagent-task]", ex)!.textContent).toBe("Find notes about pricing");
    expect($("[data-agent-subagent-status]", ex)!.textContent).toBe("Done");
    expect($("[data-agent-subagent-elapsed]", ex)!.textContent).toMatch(/^· /);
    expect($("[data-agent-subagent-counts]", ex)!.textContent).toBe(
      "2 tool calls · 1 file read · 0 edits",
    );
    const wk = card("toolu_wk");
    expect($("[data-agent-subagent-role]", wk)!.textContent).toBe("Worker");
    expect($("[data-agent-subagent-model]", wk)!.textContent).toBe("Sonnet");
    expect($("[data-agent-subagent-counts]", wk)!.textContent).toContain("1 edit");
  });

  it("shows the model the event gave, short, with the full id as the tooltip", async () => {
    const chat = finished();
    chat.turns[0]!.subagents!.toolu_ex!.model = "claude-haiku-4-5";
    await mount(chat);
    const model = $("[data-agent-subagent-model]", card("toolu_ex"))!;
    expect(model.textContent).toBe("Haiku 4.5");
    expect(model.getAttribute("title")).toBe("claude-haiku-4-5");
  });

  it("shows the final answer as the summary and not twice inside", async () => {
    await mount(finished());
    const ex = card("toolu_ex");
    expect($("[data-agent-subagent-summary]", ex)!.textContent).toBe(
      "Found 2 notes: Plan.md and Pricing.md.",
    );
    act(() => headerOf(ex).click());
    expect(ex.textContent!.split("Found 2 notes: Plan.md and Pricing.md.")).toHaveLength(2);
  });

  it("is collapsed once done and a click opens it onto the sub-agent's own rows", async () => {
    await mount(finished());
    const ex = card("toolu_ex");
    expect(headerOf(ex).getAttribute("aria-expanded")).toBe("false");
    expect($$("[data-agent-group]", ex)).toHaveLength(0);
    act(() => headerOf(ex).click());
    expect(headerOf(ex).getAttribute("aria-expanded")).toBe("true");
    // thinking, Grep and Read are one run of rows: a group, with the sub-agent's rows in it
    const groups = $$("[data-agent-group]", ex);
    expect(groups).toHaveLength(1);
    act(() => groups[0]!.querySelector<HTMLButtonElement>("button")!.click());
    expect($$("[data-agent-tool]", ex).map((t) => t.textContent)).toEqual([
      expect.stringContaining("pricing"),
      expect.stringContaining("Pricing.md"),
    ]);
    act(() => headerOf(ex).click());
    expect(headerOf(ex).getAttribute("aria-expanded")).toBe("false");
  });

  it("has no live card while it runs: a quiet start line per run, the tray shows the rest", async () => {
    await mount(running());
    expect($$("[data-agent-subagent]")).toHaveLength(0);
    expect($$("[data-agent-subagent-start]").map((l) => l.textContent)).toEqual([
      "Started Explorer: Find notes about pricing",
      "Started Worker: Fix the typo in Plan",
    ]);
  });

  it("shows the start line and the result card once finished, never a live one", async () => {
    await mount(finished());
    expect($$("[data-agent-subagent-start]")).toHaveLength(2);
    expect($$("[data-agent-subagent]")).toHaveLength(2);
    expect(
      $$("[data-agent-subagent] [data-agent-subagent-status]").map((s) => s.textContent),
    ).toEqual(["Done", "Done"]);
  });

  it("shows an interrupted run as interrupted, not done", async () => {
    const chat = finished();
    chat.turns[0]!.subagents!.toolu_ex!.status = "interrupted";
    await mount(chat);
    expect($("[data-agent-subagent-status]", card("toolu_ex"))!.textContent).toBe("Interrupted");
  });

  it("keeps the main agent's text and the delegation in the main timeline", async () => {
    await mount(finished());
    const turn = $("[data-agent-turn]")!;
    const direct = [...turn.children].map((c) =>
      c.hasAttribute("data-agent-subagent")
        ? "card"
        : (c.getAttribute("data-agent-group") ?? c.tagName),
    );
    expect(direct).toContain("card");
    expect(turn.textContent).toContain("I will hand the search and the fix to two helpers.");
    expect(turn.textContent).toContain("Both helpers are done.");
    // the launch calls are cards, not tool rows of the main timeline
    const mainTools = $$("[data-agent-tool]").filter((t) => !t.closest("[data-agent-subagent]"));
    expect(mainTools).toHaveLength(0);
  });

  it("shows a failed run as failed", async () => {
    const chat = finished();
    chat.turns[0]!.subagents!.toolu_wk!.status = "failed";
    await mount(chat);
    expect(card("toolu_wk").getAttribute("data-state")).toBe("failed");
    expect($("[data-agent-subagent-status]", card("toolu_wk"))!.textContent).toBe("Failed");
  });
});

describe("the permission card of a sub-agent", () => {
  const REQ: PermissionView = {
    requestId: "r1",
    toolCallId: "toolu_w_edit",
    tool: "Edit",
    displayName: "Edit",
    input: { file_path: "/vault/Plan.md" },
    description: null,
    decisionReason: null,
    suggestions: [],
  };
  const mountReq = async (req: PermissionView) =>
    act(async () => root.render(<PermissionCard request={req} more={0} />));

  it("names the role: Worker wants to edit X", async () => {
    await mountReq({ ...REQ, by: "worker" });
    expect($("[data-agent-permission-summary]")!.textContent).toBe(
      "Worker wants to edit /vault/Plan.md",
    );
  });

  it("keeps saying the agent for the main agent", async () => {
    await mountReq(REQ);
    expect($("[data-agent-permission-summary]")!.textContent).toBe(
      "The agent wants to edit /vault/Plan.md",
    );
  });

  it("falls back to the type's own name for a sub-agent Writer does not define", async () => {
    await mountReq({ ...REQ, by: "my-agent" });
    expect($("[data-agent-permission-summary]")!.textContent).toBe(
      "my-agent wants to edit /vault/Plan.md",
    );
  });
});

describe("the Changes card links to the sub-agent that made the edit", () => {
  it("scrolls to and focuses the card of the run", async () => {
    const chat = finished();
    const turn: Turn = {
      ...chat.turns[0]!,
      changes: {
        turnId: "t1",
        files: [
          {
            path: "Plan.md",
            status: "modified",
            added: 1,
            removed: 1,
            by: "worker",
            byCall: "toolu_wk",
          },
          { path: "Old.md", status: "modified", added: 1, removed: 0, by: "worker" },
        ],
      },
    };
    configureAgentRuntimeForTests({
      ...createMockAgentClient({ goldens: goldens as unknown as Goldens }),
      turnChanges: async () => ({ turnId: "t1", files: [] }),
    });
    // The DOM scrollIntoView would also move the window frame: only the transcript's scroller moves.
    const domScroll = vi.fn();
    Element.prototype.scrollIntoView = domScroll;
    container.style.overflowY = "auto";
    const rectOf = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      if (this === container) return { top: 0, height: 100, bottom: 100 } as DOMRect;
      if (this.getAttribute("data-agent-subagent") === "toolu_wk")
        return { top: 500, height: 40, bottom: 540 } as DOMRect;
      return rectOf.call(this);
    };
    await act(async () =>
      root.render(
        <>
          <Transcript chat={{ ...chat, turns: [turn] }} />
        </>,
      ),
    );
    const links = $$("button[data-agent-change-by]");
    // a file without a run id (an older note) keeps the plain label
    expect(links).toHaveLength(1);
    expect($$("span[data-agent-change-by]")).toHaveLength(1);
    act(() => links[0]!.click());
    Element.prototype.getBoundingClientRect = rectOf;
    expect(domScroll).not.toHaveBeenCalled();
    expect(container.scrollTop).toBe(470); // the card's middle to the middle of the transcript
    expect(document.activeElement).toBe(headerOf(card("toolu_wk")));
  });
});
