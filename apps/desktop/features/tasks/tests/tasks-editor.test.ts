// @vitest-environment jsdom
import { markdown } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));

import { taskCompletionAt, isoDay, RECURRENCES } from "../web/lib/completions";
import { customStatusRange, statusMarks, STATUS_CLASS } from "../web/status-marks";
import { tasksQueryInFence } from "../web/query-decorations";

const today = new Date(2024, 2, 15); // Friday 2024-03-15

describe("completions after a signifier or a Dataview key", () => {
  const labels = (before: string) => taskCompletionAt(before, today)?.options.map((o) => o.label);

  it("offers dates after a date signifier, with the value Rust reads", () => {
    const c = taskCompletionAt("- [ ] pay 📅 ", today)!;
    expect(c.from).toBe("- [ ] pay 📅 ".length);
    const byLabel = Object.fromEntries(c.options.map((o) => [o.label, o.apply]));
    expect(byLabel.today).toBe("2024-03-15");
    expect(byLabel.tomorrow).toBe("2024-03-16");
    expect(byLabel["next week"]).toBe("2024-03-22");
    expect(byLabel["next month"]).toBe("2024-04-15");
    // weekdays name their next occurrence, strictly after today
    expect(byLabel.friday).toBe("2024-03-22");
    expect(byLabel.monday).toBe("2024-03-18");
  });

  it("keeps the typed part out of `from` so it is replaced", () => {
    const before = "- [ ] a ⏳ tom";
    expect(taskCompletionAt(before, today)!.from).toBe(before.length - 3);
    expect(labels("- [ ] a 🛫tom")).toContain("tomorrow");
  });

  it("offers priorities and recurrences for their keys", () => {
    expect(labels("- [ ] a [priority:: ")).toEqual(["highest", "high", "medium", "low", "lowest"]);
    expect(labels("- [ ] a 🔁 ev")).toEqual(RECURRENCES);
    expect(labels("- [ ] a [repeat:: ")).toEqual(RECURRENCES);
    expect(labels("- [ ] a [due:: ")).toContain("today");
    expect(labels("- [ ] a (scheduled:: to")).toContain("today");
  });

  it("offers nothing outside a value or off a task line", () => {
    expect(labels("- [ ] plain text")).toBeUndefined();
    expect(labels("- [ ] a 📅 2024-03-20 and then more words")).toBeUndefined();
    expect(labels("a 📅 ")).toBeUndefined();
    expect(labels("- plain bullet 📅 ")).toBeUndefined();
    expect(labels("- [ ] a [other:: ")).toBeUndefined();
  });

  it("isoDay pads", () => {
    expect(isoDay(new Date(2024, 0, 5))).toBe("2024-01-05");
  });
});

describe("custom statuses", () => {
  it("finds the [c] of a list item whose box core does not draw", () => {
    expect(customStatusRange("- [/] doing", 10)).toEqual({ from: 12, to: 15, symbol: "/" });
    expect(customStatusRange("  * [!] hot", 0)).toEqual({ from: 4, to: 7, symbol: "!" });
    expect(customStatusRange("1. [-] no", 0)?.symbol).toBe("-");
  });

  it("leaves boxes core draws and non-tasks alone", () => {
    for (const line of ["- [ ] a", "- [x] a", "- [X] a", "- [/]no space", "text [/] x", "- [] a"]) {
      expect(customStatusRange(line, 0)).toBeNull();
    }
  });

  it("marks the symbol in a live editor, not inside a code fence", () => {
    const doc = "- [/] doing\n- [ ] open\n\n```\n- [!] code\n```\n";
    const host = document.createElement("div");
    const view = new EditorView({
      parent: host,
      state: EditorState.create({ doc, extensions: [markdown(), statusMarks] }),
    });
    ensureSyntaxTree(view.state, view.state.doc.length, 1000);
    view.dispatch({});
    const marks = host.querySelectorAll(`.${STATUS_CLASS}`);
    expect([...marks].map((m) => m.getAttribute("data-status"))).toEqual(["/"]);
    view.destroy();
  });
});

describe("the ```tasks card", () => {
  const found = (doc: string) => {
    const state = EditorState.create({ doc, extensions: [markdown()] });
    const tree = ensureSyntaxTree(state, doc.length, 1000)!;
    const out: ReturnType<typeof tasksQueryInFence>[] = [];
    tree.iterate({ enter: (n) => void out.push(tasksQueryInFence(state, n.node)) });
    return out.filter(Boolean);
  };

  it("takes a closed tasks fence with a body", () => {
    const hits = found("a\n```tasks\nnot done\ndue today\n```\n");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.source.trim()).toBe("not done\ndue today");
  });

  it("leaves an unclosed, empty or other fence alone", () => {
    expect(found("```tasks\nnot done")).toHaveLength(0);
    expect(found("```tasks\n```\n")).toHaveLength(0);
    expect(found("```js\nx\n```\n")).toHaveLength(0);
  });
});
