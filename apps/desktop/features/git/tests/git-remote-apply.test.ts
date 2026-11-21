// A fetched change to an open note: held until the typing idle, applied as one editor transaction
// (one undo step, the caret mapped), merged with unsaved typing, and kept when the sides overlap.
// @vitest-environment jsdom
import { history, undo } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { forgetTyping, noteTyping, TYPING_IDLE_MS } from "@/lib/typing-idle";
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
  };
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
    expect(file.diskContent).toBe("theirs\n");
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

  it("lets a claim lapse after its time to live", () => {
    open("x\n");
    const clock = { t: 0 };
    const { applier } = make(clock);
    applier.announce(["a.md"]);
    clock.t = 61_000;
    expect(applier.claim(PATH, "modify")).toBe(false);
  });
});
