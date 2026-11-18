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

import { SubagentTray } from "@features/agent/web/components/subagent-tray";
import { Transcript } from "@features/agent/web/components/transcript";
import type { AgentEvent } from "@features/agent/web/lib/events";
import { appendUserTurn, createChat, reduceEvents } from "@features/agent/web/lib/reduce";
import type { Chat } from "@features/agent/web/lib/transcript";
import { chatAfter } from "./helpers/agent-subagents";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
  vi.useRealTimers();
});

const $ = <T extends Element = HTMLElement>(sel: string, from: ParentNode = container) =>
  from.querySelector<T>(sel);
const $$ = (sel: string, from: ParentNode = container) => [
  ...from.querySelectorAll<HTMLElement>(sel),
];
const mount = async (chat: Chat) => act(async () => root.render(<SubagentTray chat={chat} />));
const lines = () => $$("[data-agent-tray-run]");
const buttonOf = (el: HTMLElement) => el.querySelector<HTMLButtonElement>("button[aria-expanded]")!;

/** `n` background runs of the same chat, all still running, launched at `now`. */
function runningChat(n: number, now = 1000): Chat {
  const events: AgentEvent[] = [];
  for (let i = 1; i <= n; i++) {
    const id = `toolu_a${i}`;
    events.push(
      {
        type: "tool-call-started",
        toolCallId: id,
        messageId: "m",
        tool: "Agent",
        parentToolCallId: null,
      },
      {
        type: "tool-call-input",
        toolCallId: id,
        input: {
          subagent_type: "general-purpose",
          description: `Task number ${i}`,
          run_in_background: true,
        },
      },
      {
        type: "subagent-started",
        toolCallId: id,
        role: null,
        name: "general-purpose",
        model: "sonnet",
      },
      { type: "subagent-status", toolCallId: id, status: "running", report: null },
      {
        type: "tool-call-started",
        toolCallId: `${id}_read`,
        messageId: `mm${i}`,
        tool: "Read",
        parentToolCallId: id,
      },
      {
        type: "tool-call-input",
        toolCallId: `${id}_read`,
        input: { file_path: `/vault/Note ${i}.md` },
      },
    );
  }
  const chat = appendUserTurn(
    createChat("c"),
    { messageId: "u", text: "go", context: [] },
    0,
    true,
  );
  return reduceEvents(chat, events, now);
}

const finish = (chat: Chat, id: string, now: number, status: "completed" | "failed" | "stopped") =>
  reduceEvents(
    chat,
    [
      {
        type: "subagent-status",
        toolCallId: id,
        status,
        report: status === "completed" ? "Report." : null,
      },
    ],
    now,
  );

describe("the sub-agent tray", () => {
  it("renders nothing without a sub-agent", async () => {
    await mount(
      appendUserTurn(createChat("c"), { messageId: "u", text: "go", context: [] }, 0, true),
    );
    expect($("[data-agent-tray]")).toBeNull();
  });

  it("shows one compact line for a running sub-agent: task, model, elapsed, tools, activity", async () => {
    await mount(runningChat(1));
    expect(lines()).toHaveLength(1);
    const line = lines()[0]!;
    expect(line.getAttribute("data-state")).toBe("running");
    expect($("[data-agent-tray-task]", line)!.textContent).toBe("Task number 1");
    expect($("[data-agent-tray-model]", line)!.textContent).toContain("Sonnet");
    expect($("[data-agent-tray-tools]", line)!.textContent).toBe("1 tool");
    expect($("[data-agent-tray-activity]", line)!.textContent).toContain("Note 1.md");
    expect($("[data-agent-tray-summary]")).toBeNull();
  });

  it("is a list with a keyboard-reachable button per line", async () => {
    await mount(runningChat(2));
    const list = $("ul[aria-label]")!;
    expect(list.querySelectorAll(":scope > li")).toHaveLength(2);
    for (const line of lines()) expect(buttonOf(line).tagName).toBe("BUTTON");
  });

  it("lists two sub-agents without folding", async () => {
    await mount(runningChat(2));
    expect(lines()).toHaveLength(2);
    expect($("[data-agent-tray-summary]")).toBeNull();
  });

  it("folds three or more into one summary line that expands and folds again", async () => {
    await mount(runningChat(3));
    const summary = $<HTMLButtonElement>("[data-agent-tray-summary]")!;
    expect(summary.textContent).toContain("3 agents running");
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    expect(lines()).toHaveLength(0);
    act(() => summary.click());
    expect(summary.getAttribute("aria-expanded")).toBe("true");
    expect(lines()).toHaveLength(3);
    act(() => summary.click());
    expect(lines()).toHaveLength(0);
  });

  it("expands a line in place into its live activity with its own scroll, and collapses it", async () => {
    await mount(runningChat(1));
    const line = lines()[0]!;
    expect($("[data-agent-tray-body]", line)).toBeNull();
    act(() => buttonOf(line).click());
    const body = $("[data-agent-tray-body]", line)!;
    expect(buttonOf(line).getAttribute("aria-expanded")).toBe("true");
    expect(body.textContent).toContain("Note 1.md");
    expect(body.className).toContain("overflow-y-auto");
    expect(body.className).toContain("max-h-");
    act(() => buttonOf(line).click());
    expect($("[data-agent-tray-body]", line)).toBeNull();
  });

  it("ticks the elapsed time while a run goes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    await mount(runningChat(1, Date.now()));
    expect($("[data-agent-tray-elapsed]")!.textContent).toContain("<1s");
    await act(async () => {
      vi.advanceTimersByTime(65_000);
    });
    expect($("[data-agent-tray-elapsed]")!.textContent).toContain("1m 5s");
  });

  it("keeps a finished line (done, failed, stopped) with its total time", async () => {
    let chat = runningChat(3, 1000);
    chat = finish(chat, "toolu_a1", 4000, "completed");
    chat = finish(chat, "toolu_a2", 5000, "failed");
    chat = finish(chat, "toolu_a3", 6000, "stopped");
    await mount(chat);
    const summary = $<HTMLButtonElement>("[data-agent-tray-summary]")!;
    expect(summary.textContent).toContain("3 agents finished");
    act(() => summary.click());
    expect($$("[data-agent-tray-status]").map((s) => s.textContent)).toEqual([
      "Done · 3s",
      "Failed · 4s",
      "Stopped · 5s",
    ]);
    expect(lines().map((l) => l.getAttribute("data-state"))).toEqual(["done", "failed", "stopped"]);
    expect($("[data-agent-tray-live]")!.textContent).toBe(
      "Task number 1: Done. Task number 2: Failed. Task number 3: Stopped",
    );
  });

  it("announces a finished run politely and keeps it until the next send, then clears", async () => {
    let chat = finish(runningChat(1, 1000), "toolu_a1", 3000, "completed");
    await mount(chat);
    expect(lines()).toHaveLength(1);
    const live = $("[data-agent-tray-live]")!;
    expect(live.parentElement!.querySelector("[role=status][aria-live=polite]")).toBe(live);
    expect(live.textContent).toBe("Task number 1: Done");
    // a later message of the same turn does not clear it; the user's next send does
    chat = appendUserTurn(chat, { messageId: "u2", text: "next", context: [] }, 4000, true);
    await mount(chat);
    expect($("[data-agent-tray]")).toBeNull();
  });

  it("keeps a run that still goes across the user's next send", async () => {
    let chat = runningChat(2, 1000);
    chat = finish(chat, "toolu_a1", 2000, "completed");
    chat = appendUserTurn(chat, { messageId: "u2", text: "next", context: [] }, 3000, true);
    await mount(chat);
    expect(lines().map((l) => $("[data-agent-tray-task]", l)!.textContent)).toEqual([
      "Task number 2",
    ]);
  });

  it("says a tool of the run waits for permission", async () => {
    const chat = runningChat(1);
    const read = chat.turns[0]!.blocks.find((b) => b.id === "toolu_a1_read");
    if (read?.kind === "tool") read.status = "waiting";
    await mount(chat);
    expect($("[data-agent-tray-activity]")!.textContent).toBe("Waiting for permission");
  });
});

describe("the tray and the transcript read the same state", () => {
  it("a running sub-agent is in the tray and only a start line in the transcript", async () => {
    const chat = chatAfter("subagent-parallel", {
      until: (e) => e.type === "tool-call-finished" && e.toolCallId === "toolu_w_edit",
    });
    await act(async () =>
      root.render(
        <>
          <Transcript chat={chat} />
          <SubagentTray chat={chat} />
        </>,
      ),
    );
    expect(lines()).toHaveLength(2);
    expect($$("[data-agent-subagent-start]")).toHaveLength(2);
    expect($$("[data-agent-subagent]")).toHaveLength(0);
  });

  it("a finished sub-agent is a result card with its report in the transcript and a done line in the tray", async () => {
    const chat = chatAfter("subagent-parallel");
    await act(async () =>
      root.render(
        <>
          <Transcript chat={chat} />
          <SubagentTray chat={chat} />
        </>,
      ),
    );
    expect($$("[data-agent-subagent]")).toHaveLength(2);
    expect($("[data-agent-subagent-summary]")!.textContent).toBe(
      "Found 2 notes: Plan.md and Pricing.md.",
    );
    expect(lines().map((l) => l.getAttribute("data-state"))).toEqual(["done", "done"]);
    expect(container.textContent).not.toMatch(/Async agent|agentId|output_file/);
  });
});
