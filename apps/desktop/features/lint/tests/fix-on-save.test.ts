// Fix on idle, end to end over the real save engine and a real CodeMirror editor, with the Rust
// call mocked by a small stand-in (it trims trailing spaces and answers the edits like the
// engine does): the fix runs after FIX_IDLE_MS without an edit (the timer restarts on typing),
// leaves the lines being typed in alone, is one undo step, is skipped when the note changed while
// Rust worked, is off by the setting, and is never run for what an agent or the disk changed. The
// edit it makes goes out through the normal autosave.
// @vitest-environment jsdom
import { history, isolateHistory, undo } from "@codemirror/commands";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));
vi.mock("@/lib/theme", () => ({ applyTheme: vi.fn() }));

/** What the Rust engine does for these tests: remove trailing spaces, as UTF-16 edits. */
function trimEdits(text: string, keep: readonly { from: number; to: number }[] = []) {
  const edits: { from: number; to: number; insert: string }[] = [];
  let at = 0;
  for (const line of text.split("\n")) {
    const trailing = /( +)$/.exec(line);
    // like the engine: a fix with an edit in or touching a kept range is dropped
    const kept = keep.some((k) => at <= k.to && at + line.length >= k.from);
    if (trailing && !kept)
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
  fix: vi.fn(async (text: string, scope: string, keep: { from: number; to: number }[] = []) => {
    await gate.hold;
    const edits = trimEdits(text, keep);
    let fixed = text;
    for (const e of [...edits].reverse()) fixed = fixed.slice(0, e.from) + fixed.slice(e.to);
    return { text: fixed, applied: edits.length ? ["MD009"] : [], edits, scope };
  }),
}));

import { invoke } from "@tauri-apps/api/core";
import { editorNotePath, registerEditorView } from "@/lib/editor-views";
import { createFeatureHost } from "@/lib/features/registry";
import { useEditorStore } from "@/stores/editor-store";
import { useFeatureHealth } from "@/stores/feature-health-store";
import { useSettingsStore } from "@/stores/settings-store";
import { fix } from "../web/ipc";
import { FIX_IDLE_MS, fixView, idleFix } from "../web/lib/fix";
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
        idleFix,
        editorNotePath.of(() => path),
        EditorState.allowMultipleSelections.of(true),
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

const settle = () => vi.advanceTimersByTimeAsync(FIX_IDLE_MS + 10);

describe("a save the editor asked for", () => {
  it("writes the fixed note, and the editor shows it", async () => {
    const v = mount("a   \nb");
    v.dispatch({ selection: { anchor: 6 } }); // on the second line, the first is not being typed in
    type(v, "!");
    await settle();
    expect(v.state.doc.toString()).toBe("a\nb!");
    // the typing was saved at once, the fix went out through the normal autosave
    expect(writes).toEqual(["a   \nb!", "a\nb!"]);
    expect(fix).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fix).mock.calls[0]![1]).toBe("safe");
    expect(useEditorStore.getState().openFiles.get(PATH)?.isDirty).toBe(false);
  });

  it("is one undo step: undo restores the note as it was typed, a second undo the typing", async () => {
    const v = mount("a   \nb");
    // typing right where the fix will remove text: without its own undo step the two would join
    v.dispatch({
      changes: { from: 4, insert: " " },
      selection: { anchor: 6 },
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
    await fixView(v, "all"); // an autosave would keep this line; Fix all does not
    expect(v.state.selection.main.head).toBe(1);
  });

  it("is skipped when the note changed while the engine worked", async () => {
    const v = mount("a   \nb");
    let release!: () => void;
    gate.hold = new Promise<void>((r) => (release = r));
    type(v, "!");
    await vi.advanceTimersByTimeAsync(FIX_IDLE_MS + 10);
    expect(fix).toHaveBeenCalledTimes(1);
    type(v, "?"); // typed while Rust is still working
    release();
    await vi.advanceTimersByTimeAsync(10);
    expect(v.state.doc.toString()).toBe("a   \nb!?");
    expect(fix).toHaveBeenCalledTimes(1);
  });
});

describe("the lines being typed in", () => {
  it("typing `# ` then an autosave keeps the space", async () => {
    const v = mount("");
    v.dispatch({
      changes: { from: 0, insert: "# " },
      selection: { anchor: 2 },
      userEvent: "input.type",
    });
    await settle();
    expect(v.state.doc.toString()).toBe("# ");
    expect(writes).toEqual(["# "]);
  });

  it("trailing spaces of the line being typed survive, those of other lines are fixed", async () => {
    const v = mount("a   \nword ");
    v.dispatch({ selection: { anchor: 10 } });
    type(v, " ");
    await settle();
    expect(v.state.doc.toString()).toBe("a\nword  ");
    expect(writes.at(-1)).toBe("a\nword  ");
  });

  it("every selection range keeps its lines", async () => {
    const v = mount("a  x\nb   \nc   \nd   ", PATH);
    v.dispatch({
      selection: EditorSelection.create([EditorSelection.cursor(1), EditorSelection.cursor(11)]),
    });
    await fixView(v, "safe", { keepEditedLines: true });
    expect(v.state.doc.toString()).toBe("a  x\nb\nc   \nd");
  });

  it("is skipped when the caret moved while the engine worked", async () => {
    const v = mount("a   \nb");
    let release!: () => void;
    gate.hold = new Promise<void>((r) => (release = r));
    const done = fixView(v, "safe", { keepEditedLines: true });
    v.dispatch({ selection: { anchor: 2 } });
    release();
    await expect(done).resolves.toBe(false);
    expect(v.state.doc.toString()).toBe("a   \nb");
  });

  it("never runs mid-composition", async () => {
    const v = mount("a   \nb");
    Object.defineProperty(v, "composing", { value: true });
    v.dispatch({ selection: { anchor: 6 } });
    type(v, "!");
    await settle();
    expect(fix).not.toHaveBeenCalled();
  });

  it("Fix all fixes the line with the caret too", async () => {
    const v = mount("a   \nb ");
    v.dispatch({ selection: { anchor: 7 } });
    await expect(fixView(v, "all")).resolves.toBe(true);
    expect(v.state.doc.toString()).toBe("a\nb");
  });
});

describe("the idle timer", () => {
  const typeOnSecondLine = (v: EditorView) => {
    v.dispatch({ selection: { anchor: 6 } });
    type(v, "!");
  };

  it("fixes at 5 s without an edit, not before", async () => {
    const v = mount("a   \nb");
    typeOnSecondLine(v);
    await vi.advanceTimersByTimeAsync(FIX_IDLE_MS - 100);
    expect(fix).not.toHaveBeenCalled();
    expect(v.state.doc.toString()).toBe("a   \nb!");
    await vi.advanceTimersByTimeAsync(100);
    expect(fix).toHaveBeenCalledTimes(1);
    expect(v.state.doc.toString()).toBe("a\nb!");
  });

  it("restarts at every edit", async () => {
    const v = mount("a   \nb");
    typeOnSecondLine(v);
    await vi.advanceTimersByTimeAsync(FIX_IDLE_MS - 100);
    type(v, "?");
    await vi.advanceTimersByTimeAsync(FIX_IDLE_MS - 100);
    expect(fix).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(fix).toHaveBeenCalledTimes(1);
    expect(v.state.doc.toString()).toBe("a\nb!?");
  });

  it("keeps the line with the caret at 5 s", async () => {
    const v = mount("a   \nb  ");
    v.dispatch({ selection: { anchor: 6 } }); // the second line
    type(v, " ");
    await settle();
    expect(v.state.doc.toString()).toBe("a\nb   ");
  });

  it("dies with the view", async () => {
    const v = mount("a   \nb");
    typeOnSecondLine(v);
    v.destroy();
    await settle();
    expect(fix).not.toHaveBeenCalled();
  });

  it("the fix's own edit does not start another run", async () => {
    const v = mount("a   \nb");
    typeOnSecondLine(v);
    await settle();
    await settle();
    expect(fix).toHaveBeenCalledTimes(1);
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
    v.dispatch({ selection: { anchor: 6 } });
    type(v, "!");
    await settle();
    expect(fix).not.toHaveBeenCalled();
    expect(v.state.doc.toString()).toBe("a   \nb!");
  });

  it("a note that is not Markdown", async () => {
    const v = mount("a   \nb", "/v/code.ts");
    v.dispatch({ selection: { anchor: 6 } });
    type(v, "!");
    await settle();
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
