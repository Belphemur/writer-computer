// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const hoisted = vi.hoisted(() => ({ answer: vi.fn(async (_id: string, _a: unknown) => {}) }));
vi.mock("@features/agent/web/hooks/agent-api", () => ({
  answerAgentQuestion: (id: string, a: unknown) => hoisted.answer(id, a),
}));

import { QuestionCard } from "@features/agent/web/components/question-card";
import type { Question } from "@features/agent/web/lib/events";
import type { QuestionState, ToolBlock } from "@features/agent/web/lib/transcript";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const COLOR: Question = {
  question: "Color?",
  header: "Color",
  multiSelect: false,
  options: [
    { label: "Red", description: "warm" },
    { label: "Blue", description: "cool", preview: "#0000ff" },
  ],
};
const FRUIT: Question = {
  question: "Fruit?",
  header: "Fruit",
  multiSelect: true,
  options: [
    { label: "Apple", description: "crisp" },
    { label: "Fig", description: "soft" },
  ],
};

const blockOf = (question: Partial<QuestionState> & { questions: Question[] }): ToolBlock => ({
  kind: "tool",
  id: "t1",
  messageId: "m",
  tool: "AskUserQuestion",
  parentToolCallId: null,
  inputText: "",
  input: {},
  hasInput: true,
  status: "waiting",
  output: null,
  truncated: false,
  permission: null,
  question: { requestId: "q1", status: "pending", answers: [], ...question },
});

let container: HTMLElement;
let root: Root;
const render = (b: ToolBlock) => act(() => root.render(<QuestionCard block={b} />));
const $ = (sel: string) => container.querySelector<HTMLElement>(sel)!;
const $$ = (sel: string) => [...container.querySelectorAll<HTMLElement>(sel)];
const input = (label: string) =>
  $$("label")
    .find((l) => l.textContent?.startsWith(label))!
    .querySelector<HTMLInputElement>("input")!;
const click = (el: HTMLElement) => act(() => el.click());
const button = (name: string) => $$("button").find((b) => b.textContent === name)!;
const key = (el: Element, k: string) =>
  act(
    () =>
      void el.dispatchEvent(
        new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }),
      ),
  );
function typeText(el: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  hoisted.answer.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("question card (open)", () => {
  it("lists the options with their descriptions and an Other row; Submit waits for an answer", () => {
    render(blockOf({ questions: [COLOR] }));
    expect($("[data-agent-question]").dataset.agentQuestion).toBe("pending");
    expect($("[data-question-text]").textContent).toBe("Color?");
    expect($$("input[type=radio]")).toHaveLength(3); // two options and Other
    expect($("[data-question-options]").textContent).toContain("warm");
    expect(button("Submit").hasAttribute("disabled")).toBe(true);
    click(input("Red"));
    expect(button("Submit").hasAttribute("disabled")).toBe(false);
    click(button("Submit"));
    expect(hoisted.answer).toHaveBeenCalledWith("q1", [{ question: "Color?", answers: ["Red"] }]);
  });

  it("a multi-select is checkboxes that add up", () => {
    render(blockOf({ questions: [FRUIT] }));
    expect($$("input[type=checkbox]")).toHaveLength(3);
    click(input("Apple"));
    click(input("Fig"));
    click(button("Submit"));
    expect(hoisted.answer).toHaveBeenCalledWith("q1", [
      { question: "Fruit?", answers: ["Apple", "Fig"] },
    ]);
  });

  it("Other takes free text, in place of the options of a single choice", () => {
    render(blockOf({ questions: [COLOR] }));
    click(input("Red"));
    typeText($("input[type=text]") as HTMLInputElement, "green");
    expect(input("Red").checked).toBe(false);
    click(button("Submit"));
    expect(hoisted.answer).toHaveBeenCalledWith("q1", [{ question: "Color?", answers: ["green"] }]);
  });

  it("shows the focused option's preview in a monospace box", () => {
    render(blockOf({ questions: [COLOR] }));
    expect($("[data-question-preview]")).toBeNull();
    act(() => input("Blue").focus());
    expect($("[data-question-preview]").textContent).toBe("#0000ff");
    act(() => input("Red").focus());
    expect($("[data-question-preview]")).toBeNull();
  });

  it("several questions: tabs with progress, Submit only when all are answered", () => {
    render(blockOf({ questions: [COLOR, FRUIT] }));
    expect($$("[role=tab]").map((t) => t.textContent)).toEqual(["Color", "Fruit"]);
    expect($("[data-question-progress]").textContent).toBe("1/2");
    click(input("Blue"));
    expect($$("[role=tab]")[0]!.textContent).toBe("Color ✓");
    expect(button("Submit").hasAttribute("disabled")).toBe(true);
    click($$("[role=tab]")[1]!);
    expect($("[data-question-progress]").textContent).toBe("2/2");
    expect($("[data-question-text]").textContent).toBe("Fruit?");
    click(input("Fig"));
    expect(button("Submit").hasAttribute("disabled")).toBe(false);
    click(button("Submit"));
    expect(hoisted.answer).toHaveBeenCalledWith("q1", [
      { question: "Color?", answers: ["Blue"] },
      { question: "Fruit?", answers: ["Fig"] },
    ]);
  });

  it("keyboard: a digit picks, Enter goes to the next open question then submits, Esc skips", () => {
    render(blockOf({ questions: [COLOR, FRUIT] }));
    const card = $("[data-agent-question]");
    key(input("Red"), "2");
    expect(input("Blue").checked).toBe(true);
    key(input("Blue"), "Enter");
    expect($("[data-question-text]").textContent).toBe("Fruit?");
    key(input("Apple"), "Enter"); // nothing picked: stays
    expect(hoisted.answer).not.toHaveBeenCalled();
    key(input("Apple"), "1");
    key(input("Fig"), "2");
    expect(input("Apple").checked && input("Fig").checked).toBe(true);
    key(input("Apple"), "Enter");
    expect(hoisted.answer).toHaveBeenCalledWith("q1", [
      { question: "Color?", answers: ["Blue"] },
      { question: "Fruit?", answers: ["Apple", "Fig"] },
    ]);
    hoisted.answer.mockClear();
    key(card, "Escape");
    expect(hoisted.answer).toHaveBeenCalledWith("q1", null);
  });

  it("arrow keys move focus between the checkboxes of a multi-select", () => {
    render(blockOf({ questions: [FRUIT] }));
    act(() => input("Apple").focus());
    key(input("Apple"), "ArrowDown");
    expect(document.activeElement).toBe(input("Fig"));
    key(input("Fig"), "ArrowUp");
    expect(document.activeElement).toBe(input("Apple"));
  });

  it("typing a digit in the Other field is text, not a pick", () => {
    render(blockOf({ questions: [COLOR] }));
    key($("input[type=text]"), "1");
    expect(input("Red").checked).toBe(false);
  });

  it("Skip declines", () => {
    render(blockOf({ questions: [COLOR] }));
    click(button("Skip"));
    expect(hoisted.answer).toHaveBeenCalledWith("q1", null);
  });
});

describe("question card (finished)", () => {
  it("collapses to question and answer", () => {
    render(
      blockOf({
        questions: [COLOR, FRUIT],
        status: "answered",
        answers: [
          { question: "Color?", answers: ["Red"] },
          { question: "Fruit?", answers: ["Apple", "my own"] },
        ],
      }),
    );
    expect($("[data-agent-question]").dataset.agentQuestion).toBe("answered");
    expect($$("input")).toHaveLength(0);
    expect(container.textContent).toContain("Color?");
    expect(container.textContent).toContain("Red");
    expect(container.textContent).toContain("Apple, my own");
  });

  it("a restored note has the answers only", () => {
    render(
      blockOf({
        requestId: null,
        questions: [],
        status: "answered",
        answers: [{ question: "Color?", answers: ["Blue"] }],
      }),
    );
    expect(container.textContent).toContain("Color?");
    expect(container.textContent).toContain("Blue");
  });

  it("says Skipped or Not answered", () => {
    render(blockOf({ questions: [COLOR], status: "skipped" }));
    expect(container.textContent).toContain("Skipped");
    render(blockOf({ questions: [COLOR], status: "cancelled" }));
    expect(container.textContent).toContain("Not answered");
  });
});
