// A fetched change to an open note: held until the typing idle, applied as one editor transaction
// (one undo step, the caret mapped), merged with unsaved typing, and kept when the sides overlap.
// @vitest-environment jsdom
import { history, undo } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { forgetTyping, noteTyping, TYPING_IDLE_MS } from "@/lib/typing-idle";
import { holdSaves, registerSaveStore, scheduleSave, waitForSave } from "@/lib/save";

const tauri = vi.hoisted(() => ({ writeFile: vi.fn() }));
vi.mock("@/lib/tauri", () => ({ writeFile: tauri.writeFile }));
import {
  APPLY_EVENT,
  type ApplyDeps,
  applyRemoteChange,
  createApplier,
  minimalChange,
} from "../web/lib/remote-apply";

const PATH = "/vault/a.md";
let view: EditorView;
let file: { frontmatter: string | null; content: string; diskContent: string; isDirty: boolean };
let disk: string;
let deps: ApplyDeps;
const merge = vi.fn();
const record = vi.fn();

const open = (body: string) => {
  view = new EditorView({
    state: EditorState.create({ doc: body, extensions: [history()] }),
    parent: document.body,
  });
  file = { frontmatter: null, content: body, diskContent: body, isDirty: false };
  disk = body;
};

beforeEach(() => {
  merge.mockReset();
  record.mockReset();
  tauri.writeFile.mockReset();
  tauri.writeFile.mockImplementation(async (_p: string, text: string) => {
    disk = text;
  });
  deps = {
    getOpenFile: () => file,
    readFile: async () => disk,
    mergeText: merge,
    findView: () => view,
    updateFrontmatter: (_p, fm) => void (file.frontmatter = fm),
    updateContent: (_p, c) => void (file.content = c),
    markSaved: (_p, d, newer) => {
      file.diskContent = d;
      file.isDirty = newer;
    },
    cancelSave: vi.fn(),
    // the real hold in the tests that drive the save engine (a hold is module state)
    holdSaves: () => () => {},
    waitForSave,
    recordConflict: record,
  };
  // the real save engine over the same open note
  registerSaveStore({
    getOpenFile: () => file as never,
    markSaved: (_p, d, newer) => {
      file.diskContent = d;
      file.isDirty = newer;
    },
    setSaveError: () => {},
  });
});
afterEach(() => {
  view?.destroy();
  forgetTyping(PATH);
});

describe("minimalChange", () => {
  it("is the smallest replacement, null when equal", () => {
    expect(minimalChange("abc", "abc")).toBeNull();
    expect(minimalChange("hello world", "hello brave world")).toEqual({
      from: 6,
      to: 6,
      insert: "brave ",
    });
    expect(minimalChange("abcd", "ad")).toEqual({ from: 1, to: 3, insert: "" });
  });
});

describe("applyRemoteChange", () => {
  it("is one undo step and keeps the caret after the change where it was", async () => {
    open("one\ntwo\nthree\n");
    view.dispatch({ selection: { anchor: 12 } }); // inside "three"
    disk = "zero\none\ntwo\nthree\n";
    expect(await applyRemoteChange(PATH, deps)).toBe("applied");
    expect(view.state.doc.toString()).toBe(disk);
    expect(view.state.selection.main.head).toBe(17);
    expect(file.diskContent).toBe(disk);
    expect(file.isDirty).toBe(false);
    undo(view);
    expect(view.state.doc.toString()).toBe("one\ntwo\nthree\n");
  });

  it("tags the transaction as git.sync", async () => {
    open("a\n");
    const events: string[] = [];
    const orig = view.dispatch.bind(view);
    view.dispatch = ((spec: { userEvent?: string }) => {
      if (spec.userEvent) events.push(spec.userEvent);
      orig(spec as never);
    }) as never;
    disk = "a\nb\n";
    await applyRemoteChange(PATH, deps);
    expect(events).toEqual([APPLY_EVENT]);
  });

  it("does nothing when the disk already equals what the editor saved", async () => {
    open("same\n");
    expect(await applyRemoteChange(PATH, deps)).toBe("none");
  });

  it("merges unsaved typing with the remote's change", async () => {
    open("one\ntwo\n");
    view.dispatch({ changes: { from: 0, insert: "mine " } });
    file.content = view.state.doc.toString();
    file.isDirty = true;
    disk = "one\ntwo\nthree\n";
    merge.mockResolvedValue("mine one\ntwo\nthree\n");
    expect(await applyRemoteChange(PATH, deps)).toBe("applied");
    expect(merge).toHaveBeenCalledWith(PATH, "one\ntwo\n", "mine one\ntwo\n", disk);
    expect(view.state.doc.toString()).toBe("mine one\ntwo\nthree\n");
    expect(file.isDirty).toBe(true); // the merged text is not on disk yet
  });

  it("keeps the user's text when the sides overlap", async () => {
    open("one\n");
    view.dispatch({ changes: { from: 0, to: 3, insert: "mine" } });
    file.content = "mine\n";
    file.isDirty = true;
    disk = "theirs\n";
    merge.mockResolvedValue(null);
    expect(await applyRemoteChange(PATH, deps)).toBe("kept");
    expect(view.state.doc.toString()).toBe("mine\n");
    // recorded in Rust, which wrote the buffer as the user's version
    expect(record).toHaveBeenCalledWith(PATH, "one\n", "mine\n");
    expect(file.diskContent).toBe("mine\n");
    expect(file.isDirty).toBe(false);
  });

  it("goes again when the user typed while the merge ran", async () => {
    open("one\n");
    file.content = "one more\n";
    file.isDirty = true;
    disk = "one\ntwo\n";
    merge.mockImplementation(async () => {
      file.content = "one more and more\n";
      return "x";
    });
    expect(await applyRemoteChange(PATH, deps)).toBe("retry");
  });
});

describe("createApplier", () => {
  const make = (clock: { t: number }) => {
    const every = vi.fn((_fn: () => void) => () => {});
    const applier = createApplier({
      root: () => "/vault",
      deps,
      every,
      now: () => clock.t,
    });
    return { applier, every };
  };

  it("claims only what was announced", () => {
    open("x\n");
    const { applier } = make({ t: 0 });
    expect(applier.claim(PATH, "modify")).toBe(false);
    applier.announce(["a.md"]);
    expect(applier.claim(PATH, "modify")).toBe(true);
    expect(applier.claim("/vault/other.md", "modify")).toBe(false);
  });

  it("applies after the typing idle and not before", async () => {
    open("x\n");
    const clock = { t: 100_000 };
    const { applier, every } = make(clock);
    noteTyping(PATH, clock.t);
    disk = "x\ny\n";
    applier.announce(["a.md"]);
    applier.claim(PATH, "modify");
    expect(every).toHaveBeenCalledTimes(1);
    expect(applier.pending()).toEqual([PATH]);
    clock.t += TYPING_IDLE_MS - 1;
    applier.tick();
    await Promise.resolve();
    expect(view.state.doc.toString()).toBe("x\n");
    clock.t += 1;
    applier.tick();
    await vi.waitFor(() => expect(view.state.doc.toString()).toBe("x\ny\n"));
    expect(applier.pending()).toEqual([]);
  });

  it("holds the saves of a dirty note until the sync's change is applied, then saves both sides", async () => {
    open("one\ntwo\n");
    deps.holdSaves = holdSaves;
    const clock = { t: 100_000 };
    const { applier } = make(clock);
    const type = (body: string) => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: body } });
      file.content = body;
      file.isDirty = true;
      noteTyping(PATH, clock.t);
      scheduleSave(PATH);
    };
    type("mine one\ntwo\n");
    await vi.waitFor(() => expect(tauri.writeFile).toHaveBeenCalledTimes(1));
    tauri.writeFile.mockClear();
    // Rust announces, writes, and is done; the user keeps typing during the idle wait
    applier.announce(["a.md"]);
    disk = "one\ntwo\nthree\n";
    applier.done(["a.md"]);
    type("mine one\ntwo more\n");
    clock.t += 500;
    type("mine one\ntwo more!\n");
    await new Promise((r) => setTimeout(r, 1_200));
    expect(tauri.writeFile).not.toHaveBeenCalled();
    expect(disk).toBe("one\ntwo\nthree\n");
    merge.mockResolvedValue("mine one\ntwo more!\nthree\n");
    // the store takes the result (in the app the editor's sync does it from the view)
    deps.findView = () => null;
    clock.t += TYPING_IDLE_MS;
    applier.tick();
    await vi.waitFor(() => expect(tauri.writeFile).toHaveBeenCalled());
    expect(merge).toHaveBeenCalledWith(
      PATH,
      "mine one\ntwo\n",
      "mine one\ntwo more!\n",
      "one\ntwo\nthree\n",
    );
    expect(disk).toBe("mine one\ntwo more!\nthree\n");
  });

  it("records an overlap and lets no save overwrite the other side meanwhile", async () => {
    open("one\n");
    deps.holdSaves = holdSaves;
    const clock = { t: 100_000 };
    const { applier } = make(clock);
    file.content = "mine\n";
    file.isDirty = true;
    applier.announce(["a.md"]);
    disk = "theirs\n";
    applier.done(["a.md"]);
    scheduleSave(PATH);
    let recorded = false;
    record.mockImplementation(async (_p: string, _b: string, mine: string) => {
      // Rust writes the buffer as the user's version, after the record
      expect(tauri.writeFile).not.toHaveBeenCalled();
      disk = mine;
      recorded = true;
    });
    merge.mockResolvedValue(null);
    clock.t += TYPING_IDLE_MS;
    applier.tick();
    await vi.waitFor(() => expect(recorded).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    expect(record).toHaveBeenCalledWith(PATH, "one\n", "mine\n");
    expect(tauri.writeFile).not.toHaveBeenCalled();
    expect(disk).toBe("mine\n");
  });

  it("frees an announced note Rust did not write", () => {
    open("x\n");
    const { applier } = make({ t: 0 });
    file.content = "x y\n";
    file.isDirty = true;
    applier.announce(["a.md"]);
    applier.done([]);
    expect(applier.pending()).toEqual([]);
    expect(applier.claim(PATH, "modify")).toBe(false);
  });

  it("lets a claim lapse after its time to live", () => {
    open("x\n");
    const clock = { t: 0 };
    const { applier } = make(clock);
    applier.announce(["a.md"]);
    clock.t = 61_000;
    expect(applier.claim(PATH, "modify")).toBe(false);
  });
});
