// The footer count and its popover: hidden at zero, the tooltip summary, fix-all replacing every
// occurrence (and only those) in one transaction at the live ranges, jump selecting the next one.
// @vitest-environment jsdom
import { setDiagnostics } from "@codemirror/lint";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));

import { registerEditorView } from "@/lib/editor-views";
import { useSettingsStore } from "@/stores/settings-store";
import { toDiagnostics } from "../web/editor/diagnostics";
import IssuesStatus from "../web/components/issues-status";
import { groupFindings } from "../web/lib/issue-groups";
import { useSpellStore } from "../web/lib/spell-store";
import type { Finding } from "../web/ipc";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PATH = "/v/a.md";
const TEXT = "teh cat, Teh dog, and a wrng bird, teh end";
const find = (word: string, from: number, over: Partial<Finding> = {}): Finding => ({
  start: from,
  end: from + word.length,
  kind: "spelling",
  message: "m",
  replacements: ["the"],
  ruleId: "SpellCheck",
  provider: "harper",
  ...over,
});
const FINDINGS = [
  find("teh", 0),
  find("Teh", TEXT.indexOf("Teh")),
  find("wrng", TEXT.indexOf("wrng"), { replacements: ["wrong"] }),
  find("teh", TEXT.lastIndexOf("teh")),
];
const noop = { addWord: vi.fn(), ignoreRule: vi.fn() };

let container: HTMLElement;
let root: Root;
let view: EditorView;
let unregister: () => void;

function load(text: string, findings: Finding[]) {
  view = new EditorView({ state: EditorState.create({ doc: text }) });
  view.dispatch(setDiagnostics(view.state, toDiagnostics(findings, text.length, noop)));
  unregister = registerEditorView(view, () => PATH);
  useSpellStore.getState().setResult(PATH, {
    blocks: [],
    missing: [],
    groups: groupFindings(findings, text),
  });
}

beforeEach(() => {
  useSettingsStore.setState({ settings: {} });
  useSpellStore.getState().reset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  unregister?.();
  view?.destroy();
});

const mount = () => act(async () => root.render(<IssuesStatus filePath={PATH} />));
const footer = () => container.querySelector<HTMLButtonElement>("[data-spellcheck-issues]");
const rows = () => [...document.body.querySelectorAll<HTMLElement>("[data-spellcheck-issue]")];
const click = (el: Element | undefined) => act(async () => (el as HTMLElement).click());

describe("the footer count", () => {
  it("is hidden with no findings", async () => {
    useSpellStore.getState().setResult(PATH, { blocks: [], missing: [], groups: [] });
    await mount();
    expect(footer()).toBeNull();
  });

  it("shows the count and a kind summary tooltip", async () => {
    const findings = [...FINDINGS, find("should of", 0, { kind: "grammar", ruleId: "ShouldOf" })];
    load(TEXT, findings);
    await mount();
    expect(footer()!.textContent).toBe("5");
    expect(footer()!.title).toBe("4 spelling, 1 grammar");
    expect(footer()!.querySelector("svg")).not.toBeNull();
  });
});

describe("the popover", () => {
  it("lists unique issues with counts, and fix-all replaces every occurrence at live ranges", async () => {
    load(TEXT, FINDINGS);
    await mount();
    await click(footer()!);
    expect(rows()).toHaveLength(2);
    expect(rows()[0]!.textContent).toContain("teh");
    expect(rows()[0]!.textContent).toContain("×3");
    // an edit after the check moves every range
    view.dispatch({ changes: { from: 0, insert: ">> " } });
    const chip = [...rows()[0]!.querySelectorAll("button")].find((b) => b.textContent === "the");
    await click(chip);
    expect(view.state.doc.toString()).toBe(">> the cat, The dog, and a wrng bird, the end");
  });

  it("jumps to the next occurrence, wrapping", async () => {
    load(TEXT, FINDINGS);
    await mount();
    await click(footer()!);
    const word = rows()[0]!.querySelector("button")!;
    await click(word);
    expect(view.state.selection.main.from).toBe(0);
    await click(word);
    expect(view.state.selection.main.from).toBe(TEXT.indexOf("Teh"));
    await click(word);
    await click(word);
    expect(view.state.selection.main.from).toBe(0);
  });

  it("Add to dictionary calls the handler with the word", async () => {
    const { handlers } = await import("../web/editor/linter");
    const add = vi.spyOn(handlers, "addWord").mockImplementation(() => {});
    load(TEXT, FINDINGS);
    await mount();
    await click(footer()!);
    const btn = [...rows()[1]!.querySelectorAll("button")].find((b) =>
      b.textContent!.includes("Add to dictionary"),
    );
    await click(btn);
    expect(add).toHaveBeenCalledWith("wrng");
  });
});
