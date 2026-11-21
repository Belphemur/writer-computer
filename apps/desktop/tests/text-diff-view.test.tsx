// The one diff component (src/components/diff): rendered note with marks and property rows, the
// Source toggle, "Formatting only", folded unchanged blocks, and the line diff alone for other
// text files. The agent's Changes card renders through it with the git feature never loaded.
// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

import { TextDiffView } from "@/components/diff/text-diff-view";
import { foldRuns, type DiffBlock, type DiffRow, type NoteDiff } from "@/lib/text-diff";
import { FileDiffBody } from "@features/agent/web/components/change-parts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const row = (kind: DiffRow["kind"], n: number, text = `l${n}`): DiffRow => ({
  kind,
  oldLine: kind === "add" ? null : n,
  newLine: kind === "del" ? null : n,
  text,
});
const same = (text: string): DiffBlock => ({
  style: "paragraph",
  level: 0,
  change: "same",
  parts: [{ op: "eq", text }],
});
const note: NoteDiff = {
  front: [
    { name: "status", before: "draft", after: "done" },
    { name: "owner", before: null, after: "Ada" },
    { name: "old", before: "x", after: null },
  ],
  blocks: [
    { style: "heading", level: 2, change: "same", parts: [{ op: "eq", text: "Title" }] },
    {
      style: "paragraph",
      level: 0,
      change: "changed",
      parts: [
        { op: "eq", text: "The cat " },
        { op: "del", text: "sat" },
        { op: "ins", text: "slept" },
      ],
    },
    { style: "list-item", level: 0, change: "added", parts: [{ op: "ins", text: "new item" }] },
    { style: "paragraph", level: 0, change: "removed", parts: [{ op: "del", text: "gone" }] },
  ],
};
const rows = [row("context", 1), row("del", 2), row("add", 2)];

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
const render = (node: React.ReactNode) => act(() => root.render(node));
const $ = (sel: string) => container.querySelector(sel);
const $$ = (sel: string) => [...container.querySelectorAll(sel)];
const source = () =>
  [...container.querySelectorAll("button")].find((b) => b.textContent === "Source")!;

describe("rendered view", () => {
  it("marks insertions and deletions in the text and shows front matter as property rows", () => {
    render(<TextDiffView diff={{ rows, rendered: note }} label="Changes" />);
    expect($("[data-diff-rendered]")).not.toBeNull();
    expect($("[data-diff]")).toBeNull();
    expect($('[role="heading"]')?.textContent).toBe("Title");
    expect($$('ins[data-diff-mark="ins"]').map((e) => e.textContent)).toContain("slept");
    expect($$('del[data-diff-mark="del"]').map((e) => e.textContent)).toContain("sat");
    expect($('[data-diff-block="added"][data-diff-style="list-item"]')?.textContent).toContain(
      "new item",
    );
    expect($('[data-diff-block="removed"]')?.textContent).toBe("gone");
    const props = (name: string) => $(`[data-diff-property="${name}"]`)!.textContent;
    expect(props("status")).toContain("draft");
    expect(props("status")).toContain("done");
    expect($(`[data-diff-property="owner"] del`)).toBeNull();
    expect($(`[data-diff-property="old"] ins`)).toBeNull();
  });

  it("switches to the raw line diff with the Source toggle and back", () => {
    render(<TextDiffView diff={{ rows, rendered: note }} label="Changes" />);
    act(() => source().click());
    expect($("[data-diff-rendered]")).toBeNull();
    expect($$('[data-diff-row="add"]').length).toBe(1);
    expect(source().getAttribute("aria-pressed")).toBe("true");
    act(() => source().click());
    expect($("[data-diff-rendered]")).not.toBeNull();
  });

  it("says Formatting only, starts on the source and keeps the toggle", () => {
    render(<TextDiffView diff={{ rows, rendered: note, formattingOnly: true }} label="c" />);
    expect($("[data-diff-formatting-only]")?.textContent).toBe("Formatting only");
    expect($("[data-diff]")).not.toBeNull();
    act(() => source().click());
    expect($("[data-diff-rendered]")).not.toBeNull();
  });

  it("folds unchanged blocks behind a button that opens them", () => {
    const blocks = [
      ...Array.from({ length: 8 }, (_, i) => same(`before ${i}`)),
      {
        style: "paragraph",
        level: 0,
        change: "added",
        parts: [{ op: "ins", text: "fresh" }],
      } as DiffBlock,
      ...Array.from({ length: 8 }, (_, i) => same(`after ${i}`)),
    ];
    render(<TextDiffView diff={{ rows, rendered: { front: [], blocks } }} label="c" />);
    expect($$("[data-diff-block]").length).toBe(3);
    const fold = [...container.querySelectorAll("button")].filter((b) =>
      /^Show \d+ unchanged$/.test(b.textContent ?? ""),
    );
    expect(fold.length).toBe(2);
    act(() => fold[0]!.click());
    expect($$("[data-diff-block]").length).toBeGreaterThan(3);
  });
});

describe("other text", () => {
  it("is the line diff alone, with no toggle", () => {
    render(<TextDiffView diff={{ rows }} label="Changes" />);
    expect($("[data-diff]")).not.toBeNull();
    expect($$('[data-diff-row="del"]').length).toBe(1);
    expect([...container.querySelectorAll("button")].some((b) => b.textContent === "Source")).toBe(
      false,
    );
  });
});

describe("folding", () => {
  it("hides only runs of at least two unchanged items far from a change", () => {
    const items = [..."aaaaaaaaXbbbbbbbb"];
    const segs = foldRuns(items, (c) => c !== "X");
    expect(segs.map((s) => [s.kind, s.rows.length])).toEqual([
      ["gap", 5],
      ["rows", 7],
      ["gap", 5],
    ]);
  });
});

describe("the agent's Changes card shares it", () => {
  it("shows the rendered note with the Source toggle, the card's old line view as Source", () => {
    render(
      <FileDiffBody
        f={{ path: "Notes/a.md", status: "modified", added: 1, removed: 1 } as never}
        d={{ rows, rendered: note }}
        status="ready"
        error={null}
      />,
    );
    expect($("[data-diff-rendered]")).not.toBeNull();
    act(() => source().click());
    expect($$('[data-diff-row="add"]').length).toBe(1);
  });

  it("without the rendered view (git never loaded, any other file) it is the line diff as before", () => {
    render(
      <FileDiffBody
        f={{ path: "x.json", status: "modified", added: 1, removed: 1 } as never}
        d={{ rows }}
        status="ready"
        error={null}
      />,
    );
    expect($("[data-diff]")).not.toBeNull();
    expect($("[data-diff-rendered]")).toBeNull();
  });
});
