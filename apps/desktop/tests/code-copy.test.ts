// @vitest-environment jsdom
// The copy button of the note editor's code blocks (`CodeCopyWidget`) and the shared button piece
// (`lib/code-copy-button.ts`), which the agent chat uses too (`agent-copy-selection.test.tsx`).
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";

const writeText = vi.hoisted(() => vi.fn(async (_text: string) => {}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText }));

import { codeBlockDecorationsExtension } from "../src/lib/prosemark-core/codeFenceExtension";
import { frontmatterMarkdownSyntaxExtension } from "../src/lib/prosemark-core/markdown/frontmatter";
import { mermaidDecorations } from "../src/components/editor-area/mermaid-decorations";
import { CODE_COPY_FEEDBACK_MS } from "../src/lib/code-copy-button";
import { withFullParse } from "./helpers/parsed-state";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function mount(doc: string, extra: EditorState["facet"] extends never ? never : unknown[] = []) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    parent,
    state: withFullParse(
      EditorState.create({
        doc,
        extensions: [
          markdown({ extensions: [GFM, frontmatterMarkdownSyntaxExtension] }),
          codeBlockDecorationsExtension,
          ...(extra as never[]),
        ],
      }),
    ),
  });
  cleanups.push(() => (view.destroy(), parent.remove()));
  return view;
}

const buttons = (view: EditorView) => [
  ...view.dom.querySelectorAll<HTMLButtonElement>(".cm-code-copy-slot button"),
];

async function click(button: HTMLButtonElement) {
  await vi.waitFor(() => expect(button.isConnected).toBe(true));
  button.click();
  await vi.waitFor(() => expect(writeText).toHaveBeenCalled());
}

describe("code block copy button", () => {
  beforeEach(() => writeText.mockClear());

  test("one button per fenced and indented block, none for inline code or frontmatter", () => {
    const view = mount(
      [
        "---",
        "title: x",
        "---",
        "",
        "Some `inline` code",
        "",
        "```ts",
        "a",
        "```",
        "",
        "    indented",
        "",
        "~~~",
        "b",
        "~~~",
      ].join("\n"),
    );
    const found = buttons(view);
    expect(found).toHaveLength(3);
    for (const b of found) {
      expect(b.type).toBe("button");
      expect(b.title).toBe("Copy");
      expect(b.getAttribute("aria-label")).toBe("Copy code");
      expect(b.querySelector("svg")).not.toBeNull();
      expect(b.textContent).toBe("");
    }
  });

  test("copies exactly the code between the fences", async () => {
    const cases: Array<[string, string]> = [
      ["```ts\nconst a = 1;\nconst b = 2;\n```", "const a = 1;\nconst b = 2;"],
      ["~~~md\n```js\nx()\n```\n~~~", "```js\nx()\n```"],
      ["````\n```\ninner\n```\n````", "```\ninner\n```"],
      ["```\n```", ""],
      ["```\na\n\n```", "a\n"],
      ["```py\n  indented\n\ttabbed\n```", "  indented\n\ttabbed"],
      ["```\nnaïve – 日本語 🎉\n```", "naïve – 日本語 🎉"],
      ["```\r\nline1\r\nline2\r\n```", "line1\nline2"],
      ["> ```js\n> a\n> b\n> ```", "a\nb"],
      ["- item\n\n  ```\n  a\n  b\n  ```", "a\nb"],
      ["    one\n      two", "one\n  two"],
      ["```\nunclosed", "unclosed"],
    ];
    for (const [doc, expected] of cases) {
      writeText.mockClear();
      const view = mount(doc);
      const [button] = buttons(view);
      expect(button, doc).toBeDefined();
      await click(button!);
      expect(writeText, doc).toHaveBeenLastCalledWith(expected);
    }
  });

  test("copies the block's own body when several are in the note", async () => {
    const view = mount("```a\none\n```\n\ntext\n\n```b\ntwo\n```");
    const found = buttons(view);
    await click(found[1]!);
    expect(writeText).toHaveBeenLastCalledWith("two");
    await click(found[0]!);
    expect(writeText).toHaveBeenLastCalledWith("one");
  });

  test("reads the document as it is when clicked", async () => {
    const view = mount("intro\n\n```ts\nold\n```");
    const [button] = buttons(view);
    const at = view.state.doc.toString().indexOf("old");
    view.dispatch({ changes: { from: at, to: at + 3, insert: "new\nlines" } });
    // an edit above moves the block; the same button still finds it
    view.dispatch({ changes: { from: 0, insert: "a longer intro\n\nmore\n\n" } });
    await click(button!);
    expect(writeText).toHaveBeenLastCalledWith("new\nlines");
  });

  test("a press leaves the caret, selection and focus alone", async () => {
    const view = mount("before\n\n```ts\ncode\n```\n\nafter");
    view.focus();
    view.dispatch({ selection: { anchor: 2, head: 4 } });
    const [button] = buttons(view);
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    button!.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    await click(button!);
    expect(view.state.selection.main.from).toBe(2);
    expect(view.state.selection.main.to).toBe(4);
    expect(document.activeElement).not.toBe(button);
    expect(view.state.doc.toString()).toBe("before\n\n```ts\ncode\n```\n\nafter");
  });

  test("shows when the caret is in the block and follows it", () => {
    const doc = "top\n\n```a\none\n```\n\nmid\n\n```b\ntwo\n```";
    const view = mount(doc);
    const visible = () =>
      buttons(view).map((b) => b.parentElement!.classList.contains("is-visible"));
    expect(visible()).toEqual([false, false]);
    view.dispatch({ selection: { anchor: doc.indexOf("one") } });
    expect(visible()).toEqual([true, false]);
    view.dispatch({ selection: { anchor: doc.indexOf("two") } });
    expect(visible()).toEqual([false, true]);
    view.dispatch({ selection: { anchor: doc.indexOf("mid") } });
    expect(visible()).toEqual([false, false]);
  });

  test("shows while any line of the block is hovered", () => {
    const view = mount("```a\none\ntwo\n```\n\n```b\nthree\n```");
    const lines = [...view.dom.querySelectorAll(".cm-fenced-code-line")];
    const slots = [...view.dom.querySelectorAll(".cm-code-copy-slot")];
    lines[2]!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(slots.map((s) => s.classList.contains("is-visible"))).toEqual([true, false]);
    lines.at(-1)!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(slots.map((s) => s.classList.contains("is-visible"))).toEqual([false, true]);
    view.contentDOM.dispatchEvent(new MouseEvent("mouseleave"));
    expect(slots.map((s) => s.classList.contains("is-visible"))).toEqual([false, false]);
  });

  test("a read-only editor has the button too", async () => {
    const view = mount("```\nro\n```", [
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
    ]);
    await click(buttons(view)[0]!);
    expect(writeText).toHaveBeenLastCalledWith("ro");
  });

  test("shows a check for a moment after a copy", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const view = mount("```\nx\n```");
      const [button] = buttons(view);
      button!.click();
      await vi.waitFor(() => expect(button!.classList.contains("is-copied")).toBe(true));
      expect(button!.title).toBe("Copied");
      vi.advanceTimersByTime(CODE_COPY_FEEDBACK_MS);
      expect(button!.classList.contains("is-copied")).toBe(false);
      expect(button!.title).toBe("Copy");
    } finally {
      vi.useRealTimers();
    }
  });

  test("no check when the clipboard refuses", async () => {
    writeText.mockRejectedValueOnce(new Error("denied"));
    const view = mount("```\nx\n```");
    const [button] = buttons(view);
    button!.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalled());
    await Promise.resolve();
    expect(button!.classList.contains("is-copied")).toBe(false);
  });

  test("a mermaid block copies its source from the toolbar, with no second button", async () => {
    const view = mount("```mermaid\nflowchart LR\n  A --> B\n```", [mermaidDecorations()]);
    expect(buttons(view)).toHaveLength(0);
    const copy = view.dom.querySelector<HTMLButtonElement>(".cm-mermaid-canvas-top .code-copy");
    expect(copy).not.toBeNull();
    await click(copy!);
    expect(writeText).toHaveBeenLastCalledWith("flowchart LR\n  A --> B");
  });
});
