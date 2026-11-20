// Fix on save, end to end over the real save engine and a real CodeMirror editor, with the Rust
// call mocked by a small stand-in (it trims trailing spaces and answers the edits like the
// engine does): the fix is one undo step, is skipped when the note changed while Rust worked, is
// off by the setting or the kill switch, and is never run for what an agent or the disk changed.
// @vitest-environment jsdom
import { history, isolateHistory, undo } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));
vi.mock("@/lib/theme", () => ({ applyTheme: vi.fn() }));

/** What the Rust engine does for these tests: remove trailing spaces, as UTF-16 edits. */
function trimEdits(text: string) {
  const edits: { from: number; to: number; insert: string }[] = [];
  let at = 0;
  for (const line of text.split("\n")) {
    const trailing = /( +)$/.exec(line);
    if (trailing)
      edits.push({
        from: at + line.length - trailing[1]!.length,
        to: at + line.length,
        insert: "",
      });
    at += line.length + 1;
  }
  return edits;
}
const gate: { hold: Promise<void> | null } = { hold: null };
vi.mock("../web/ipc", async (original) => ({
  ...(await original<typeof import("../web/ipc")>()),
  fix: vi.fn(async (text: string, scope: string) => {
    await gate.hold;
    const edits = trimEdits(text);
    const fixed = text
      .split("\n")
      .map((l) => l.replace(/ +$/, ""))
      .join("\n");
    return { text: fixed, applied: edits.length ? ["MD009"] : [], edits, scope };
  }),
}));

import { invoke } from "@tauri-apps/api/core";
import { registerEditorView } from "@/lib/editor-views";
import { createFeatureHost } from "@/lib/features/registry";
import { useEditorStore } from "@/stores/editor-store";
import { useFeatureHealth } from "@/stores/feature-health-store";
import { useSettingsStore } from "@/stores/settings-store";
import { fix } from "../web/ipc";
import { fixOnSave, fixView } from "../web/lib/fix";
import lint from "../web";

const PATH = "/v/note.md";
const mockedInvoke = vi.mocked(invoke);
const host = createFeatureHost({ onError: () => {} });
let view: EditorView | undefined;
let unregisterView: (() => void) | undefined;
let writes: string[];
/** Every transaction the editor ran, to see what the fix dispatched. */
let transactions: import("@codemirror/state").Transaction[];

/** An editor on `doc` that mirrors its changes into the store, as the app's editor does. */
function mount(doc: string, path = PATH) {
  view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        history(),
        EditorView.updateListener.of((u) => {
          transactions.push(...u.transactions);
          if (u.docChanged) useEditorStore.getState().updateContent(path, u.state.doc.toString());
        }),
      ],
    }),
  });
  unregisterView = registerEditorView(view, () => path);
  return view;
}

const type = (v: EditorView, text: string) =>
  v.dispatch({ changes: { from: v.state.doc.length, insert: text }, userEvent: "input.type" });

beforeEach(async () => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  gate.hold = null;
  writes = [];
  transactions = [];
  useFeatureHealth.setState({ sessionOff: {}, safeMode: false });
  useSettingsStore.setState({
    settings: { "files.trim-trailing-whitespace": false, "files.insert-final-newline": false },
    isLoaded: true,
  });
  useEditorStore.setState({
    openFiles: new Map(),
    tabs: [],
    activeTabId: null,
    activeFilePath: null,
  });
  mockedInvoke.mockImplementation((command, payload) => {
    if (command === "read_file") {
      return Promise.resolve({ path: PATH, content: "a   \nb", modified_at: 1 });
    }
    if (command === "write_file") {
      writes.push((payload as { content: string }).content);
      return Promise.resolve({ path: PATH, modified_at: 2 });
    }
    return Promise.resolve(null);
  });
  host.register(lint);
  await useEditorStore.getState().openFile(PATH);
});

afterEach(async () => {
  unregisterView?.();
  view?.destroy();
  view = undefined;
  await vi.runOnlyPendingTimersAsync();
  for (const id of host.list()) await host.unregister(id);
  vi.useRealTimers();
});

const settle = () => vi.advanceTimersByTimeAsync(10);

describe("a save the editor asked for", () => {
  it("writes the fixed note, and the editor shows it", async () => {
    const v = mount("a   \nb");
    type(v, "!");
    await settle();
    expect(v.state.doc.toString()).toBe("a\nb!");
    expect(writes).toEqual(["a\nb!"]);
    expect(fix).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fix).mock.calls[0]![1]).toBe("safe");
    // the save carried the fix: nothing is left dirty, no second write is queued
    expect(useEditorStore.getState().openFiles.get(PATH)?.isDirty).toBe(false);
    await vi.advanceTimersByTimeAsync(3000);
    expect(writes).toHaveLength(1);
  });

  it("is one undo step: undo restores the note as it was typed, a second undo the typing", async () => {
    const v = mount("a   \nb");
    // typing right where the fix will remove text: without its own undo step the two would join
    v.dispatch({
      changes: { from: 4, insert: " " },
      selection: { anchor: 5 },
      userEvent: "input.type",
    });
    await settle();
    expect(v.state.doc.toString()).toBe("a\nb");
    undo(v);
    expect(v.state.doc.toString()).toBe("a    \nb");
    undo(v);
    expect(v.state.doc.toString()).toBe("a   \nb");
  });

  it("dispatches the fix as one transaction with its own history event", async () => {
    const v = mount("a   \nb\nc   ");
    await fixView(v, "safe");
    const fixTr = transactions.filter((t) => t.isUserEvent("lint.fix"));
    expect(fixTr).toHaveLength(1);
    expect(fixTr[0]!.annotation(isolateHistory)).toBe("full");
    expect(v.state.doc.toString()).toBe("a\nb\nc");
  });

  it("keeps the caret where it was in the text", async () => {
    const v = mount("a   \nb");
    v.dispatch({ selection: { anchor: 6 } }); // after the "b"
    type(v, "!");
    await settle();
    expect(v.state.doc.toString()).toBe("a\nb!");
    expect(v.state.selection.main.head).toBe(3); // still after the "b", three characters earlier
  });

  it("puts a caret that was inside the removed spaces at the start of the gap", async () => {
    const v = mount("a   \nb");
    v.dispatch({ selection: { anchor: 3 } });
    type(v, "!");
    await settle();
    expect(v.state.selection.main.head).toBe(1);
  });

  it("is skipped when the note changed while the engine worked", async () => {
    const v = mount("a   \nb");
    let release!: () => void;
    gate.hold = new Promise<void>((r) => (release = r));
    type(v, "!");
    await settle();
    expect(fix).toHaveBeenCalledTimes(1);
    type(v, "?"); // typed while Rust is still working
    release();
    await settle();
    expect(v.state.doc.toString()).toBe("a   \nb!?");
    expect(writes[0]).toBe("a   \nb!?");
  });
});

describe("what switches it off", () => {
  it("the setting", async () => {
    useSettingsStore.setState({
      settings: { "lint.fix-on-save": false, "files.trim-trailing-whitespace": false },
    });
    const v = mount("a   \nb");
    type(v, "!");
    await settle();
    expect(fix).not.toHaveBeenCalled();
    expect(writes).toEqual(["a   \nb!"]);
  });

  it("having no safe rule on", async () => {
    useSettingsStore.setState({
      settings: {
        "lint.rules-off": ["MD004", "MD009", "MD012", "MD018", "MD019", "MD022", "MD047"],
      },
    });
    const v = mount("a   \nb");
    await fixOnSave(PATH);
    expect(fix).not.toHaveBeenCalled();
    expect(v.state.doc.toString()).toBe("a   \nb");
  });

  it("the kill switch: unregistering the feature removes the hook", async () => {
    await host.unregister("lint");
    const v = mount("a   \nb");
    type(v, "!");
    await settle();
    expect(fix).not.toHaveBeenCalled();
    expect(writes).toEqual(["a   \nb!"]);
  });

  it("a note that is not Markdown", async () => {
    mount("a   \nb", "/v/code.ts");
    await fixOnSave("/v/code.ts");
    expect(fix).not.toHaveBeenCalled();
  });

  it("a note with no editor open for it", async () => {
    await fixOnSave("/v/background.md");
    expect(fix).not.toHaveBeenCalled();
  });
});

describe("what never fixes", () => {
  it("an edit from disk or by the agent reloads the note clean: no fix, no write", async () => {
    mount("a   \nb");
    useEditorStore.getState().reloadFromDisk(PATH, "agent wrote this   \n");
    await vi.advanceTimersByTimeAsync(5000);
    expect(fix).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    expect(useEditorStore.getState().openFiles.get(PATH)?.content).toBe("agent wrote this   \n");
  });
});

describe("Fix all", () => {
  it("fixes with scope all, as one undo step", async () => {
    const v = mount("a   \nb");
    await expect(fixView(v, "all")).resolves.toBe(true);
    expect(vi.mocked(fix).mock.calls[0]![1]).toBe("all");
    expect(v.state.doc.toString()).toBe("a\nb");
    undo(v);
    expect(v.state.doc.toString()).toBe("a   \nb");
    // fixed again, and with nothing left to fix the editor is left alone
    await expect(fixView(v, "all")).resolves.toBe(true);
    await expect(fixView(v, "all")).resolves.toBe(false);
  });
});
