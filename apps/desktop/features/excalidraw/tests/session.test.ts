// One open drawing: saves after a quiet moment and only for real changes, reloads and merges by id
// and version (the user's view and unsaved edits survive), animates only the new elements and none
// with reduced motion, and ignores the echo of its own write.
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Loaded } from "../web/lib/drawing-file";
import type { ExcalidrawApi } from "../web/lib/excalidraw-lib";
import { parseDrawing, type ParsedDrawing, type SceneElement } from "../web/lib/excalidraw-md";
import { DrawingSession, SAVE_DEBOUNCE_MS, signature, type SessionDeps } from "../web/lib/session";

const NEVER = Symbol("never");
const el = (id: string, version = 1, extra: Partial<SceneElement> = {}): SceneElement => ({
  id,
  type: "rectangle",
  version,
  versionNonce: 10,
  isDeleted: false,
  opacity: 100,
  ...extra,
});

/** A drawing text whose scene is `elements`, in the plain format (the codec is tested apart). */
const textOf = (elements: SceneElement[], bg = "#ffffff") =>
  JSON.stringify({
    type: "excalidraw",
    version: 2,
    source: "s",
    elements,
    appState: { gridSize: null, viewBackgroundColor: bg },
    files: {},
  });

class FakeCanvas implements ExcalidrawApi {
  elements: readonly SceneElement[] = [];
  appStateValue: Record<string, unknown> = { viewBackgroundColor: "#ffffff", scrollX: 5 };
  updates: { elements?: readonly SceneElement[]; appState?: unknown; captureUpdate?: unknown }[] =
    [];
  added: unknown[] = [];
  updateScene(d: {
    elements?: readonly SceneElement[];
    appState?: unknown;
    captureUpdate?: unknown;
  }) {
    this.updates.push(d);
    if (d.elements) this.elements = d.elements;
  }
  getSceneElementsIncludingDeleted() {
    return this.elements;
  }
  getAppState() {
    return this.appStateValue;
  }
  getFiles() {
    return {};
  }
  addFiles(files: unknown[]) {
    this.added.push(...files);
  }
}

function setup(initial: SceneElement[], over: Partial<SessionDeps> = {}) {
  let disk = textOf(initial);
  const frames: (() => void)[] = [];
  let clock = 0;
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const save = vi.fn(
    async (
      baseline: ParsedDrawing,
      snap: { elements: readonly SceneElement[]; appState: Record<string, unknown> },
    ) => {
      disk = textOf(
        snap.elements.filter((e) => e.isDeleted !== true),
        JSON.stringify(snap.appState.viewBackgroundColor),
      );
      return { parsed: parseDrawing(disk, baseline.format), wrote: true };
    },
  );
  const problems: string[] = [];
  const onSaved = vi.fn();
  const deps: SessionDeps = {
    read: async () => disk,
    load: async (text): Promise<Loaded> => ({ parsed: parseDrawing(text, "plain"), files: {} }),
    save,
    neverCapture: NEVER,
    reducedMotion: () => false,
    onSaved,
    onProblem: (m) => problems.push(m),
    schedule: (fn, ms) => {
      const t = { fn, ms, live: true };
      timers.push(t);
      return () => {
        t.live = false;
      };
    },
    raf: (cb) => frames.push(() => cb(clock)),
    caf: () => {},
    now: () => clock,
    ...over,
  };
  const session = new DrawingSession("/v/a.excalidraw", deps);
  const canvas = new FakeCanvas();
  return {
    session,
    canvas,
    save,
    problems,
    onSaved,
    setDisk: (e: SceneElement[]) => (disk = textOf(e)),
    disk: () => disk,
    fireSave: async () => {
      const due = timers.filter((t) => t.live);
      timers.length = 0;
      due.forEach((t) => t.fn());
      await Promise.resolve();
    },
    due: () => timers.filter((t) => t.live).map((t) => t.ms),
    advance: (ms: number) => {
      clock += ms;
      frames.splice(0).forEach((f) => f());
    },
  };
}

async function opened(initial: SceneElement[], over: Partial<SessionDeps> = {}) {
  const t = setup(initial, over);
  await t.session.open();
  t.canvas.elements = initial;
  t.session.attach(t.canvas);
  return t;
}

describe("saving", () => {
  it("waits for a quiet moment, then writes once with the latest canvas", async () => {
    const t = await opened([el("a")]);
    t.session.handleChange([el("a"), el("b")], { viewBackgroundColor: "#ffffff" }, {});
    t.session.handleChange([el("a"), el("b"), el("c")], { viewBackgroundColor: "#ffffff" }, {});
    expect(t.due()).toEqual([SAVE_DEBOUNCE_MS]);
    expect(t.save).not.toHaveBeenCalled();
    await t.fireSave();
    await vi.waitFor(() => expect(t.save).toHaveBeenCalledTimes(1));
    expect(t.save.mock.calls[0]![1].elements.map((e) => e.id)).toEqual(["a", "b", "c"]);
    await vi.waitFor(() => expect(t.onSaved).toHaveBeenCalledTimes(1));
    expect(t.session.hasUnsavedChanges).toBe(false);
  });

  it("a change that is only selection or scroll is not a change", async () => {
    const t = await opened([el("a")]);
    t.session.handleChange(
      [el("a")],
      { viewBackgroundColor: "#ffffff", scrollX: 99, selectedElementIds: { a: true } },
      {},
    );
    expect(t.due()).toEqual([]);
    expect(t.session.hasUnsavedChanges).toBe(false);
  });

  it("a new background is a change", async () => {
    const t = await opened([el("a")]);
    t.session.handleChange([el("a")], { viewBackgroundColor: "#000000" }, {});
    expect(t.session.hasUnsavedChanges).toBe(true);
  });

  it("flush saves what is pending now, and a closed tab still saves", async () => {
    const t = await opened([el("a")]);
    t.session.handleChange([el("a"), el("b")], { viewBackgroundColor: "#ffffff" }, {});
    await t.session.flush();
    expect(t.save).toHaveBeenCalledTimes(1);

    const u = await opened([el("a")]);
    u.session.handleChange([el("a"), el("z")], { viewBackgroundColor: "#ffffff" }, {});
    u.session.dispose();
    await vi.waitFor(() => expect(u.save).toHaveBeenCalledTimes(1));
  });

  it("a failed save says so and keeps the change for the next one", async () => {
    const t = await opened([el("a")], {
      save: vi.fn(async () => {
        throw new Error("disk full");
      }),
    });
    t.session.handleChange([el("a"), el("b")], { viewBackgroundColor: "#ffffff" }, {});
    await t.session.flush();
    expect(t.problems[0]).toContain("disk full");
    expect(t.session.hasUnsavedChanges).toBe(true);
  });

  it("signature ignores deleted elements and anything but id, version, background and grid", () => {
    expect(signature([el("a"), el("b", 1, { isDeleted: true })], {})).toBe(
      signature([el("a")], {}),
    );
    expect(signature([el("a", 2)], {})).not.toBe(signature([el("a", 1)], {}));
  });
});

describe("reloading a change from outside", () => {
  beforeEach(() => vi.clearAllMocks());

  it("brings in what an agent added without touching the view, and draws it in", async () => {
    const t = await opened([el("a")]);
    t.setDisk([el("a"), el("b"), el("c")]);
    await t.session.reload();
    // the merge goes in as elements only: no appState, so zoom and scroll stay, and no undo step
    const first = t.canvas.updates[0]!;
    expect(first.appState).toBeUndefined();
    expect(first.captureUpdate).toBe(NEVER);
    // frame 0 shows the new elements transparent, the old one untouched
    const shown = first.elements!;
    expect(shown.find((e) => e.id === "a")).toBe(t.canvas.updates[0]!.elements![0]);
    expect(shown.find((e) => e.id === "b")!.opacity).toBe(0);
    t.advance(150);
    const mid = t.canvas.updates.at(-1)!.elements!;
    expect(mid.find((e) => e.id === "b")!.opacity).toBeGreaterThan(0);
    expect(mid.find((e) => e.id === "a")!.opacity).toBe(100);
    t.advance(400);
    const last = t.canvas.updates.at(-1)!.elements!;
    expect(last.map((e) => [e.id, e.opacity])).toEqual([
      ["a", 100],
      ["b", 100],
      ["c", 100],
    ]);
    // the reload is what is on disk: nothing to save
    expect(t.session.hasUnsavedChanges).toBe(false);
    expect(t.save).not.toHaveBeenCalled();
  });

  it("with reduced motion the new elements appear at once, never animated", async () => {
    const t = await opened([el("a")], { reducedMotion: () => true });
    t.setDisk([el("a"), el("b")]);
    await t.session.reload();
    expect(t.canvas.updates).toHaveLength(1);
    expect(t.canvas.updates[0]!.elements!.find((e) => e.id === "b")!.opacity).toBe(100);
  });

  it("the animation applies to new elements only, never to the changed old one", async () => {
    const t = await opened([el("a"), el("b")]);
    t.setDisk([el("a", 2, { x: 5 }), el("b"), el("n")]);
    await t.session.reload();
    const frame0 = t.canvas.updates[0]!.elements!;
    expect(frame0.find((e) => e.id === "a")).toMatchObject({ version: 2, opacity: 100 });
    expect(frame0.find((e) => e.id === "n")!.opacity).toBe(0);
  });

  it("keeps the user's unsaved edit and saves the merge", async () => {
    const t = await opened([el("a", 1)]);
    t.canvas.elements = [el("a", 2, { x: "mine" })];
    t.session.handleChange(t.canvas.elements, { viewBackgroundColor: "#ffffff" }, {});
    t.setDisk([el("a", 1), el("b")]);
    await t.session.reload();
    t.advance(1000);
    const merged = t.canvas.elements;
    expect(merged.find((e) => e.id === "a")!.x).toBe("mine");
    expect(merged.some((e) => e.id === "b")).toBe(true);
    // the merge differs from the file (the user's edit), so it is saved
    expect(t.session.hasUnsavedChanges).toBe(true);
    await t.session.flush();
    expect(t.save).toHaveBeenCalled();
  });

  it("ignores the echo of its own write", async () => {
    const t = await opened([el("a")]);
    t.session.handleChange([el("a"), el("b")], { viewBackgroundColor: "#ffffff" }, {});
    await t.session.flush();
    t.canvas.updates.length = 0;
    await t.session.reload();
    expect(t.canvas.updates).toEqual([]);
  });

  it("an element an agent removed goes, unless the user changed it", async () => {
    const t = await opened([el("a"), el("b")]);
    t.canvas.elements = [el("a"), el("b", 3)];
    t.setDisk([]);
    await t.session.reload();
    t.advance(1000);
    const state = Object.fromEntries(t.canvas.elements.map((e) => [e.id, e.isDeleted]));
    expect(state).toEqual({ a: true, b: false });
  });

  it("a file that no longer parses is reported and the canvas is left alone", async () => {
    const t = await opened([el("a")]);
    t.setDisk([el("a")]);
    (t.session as unknown as { deps: SessionDeps }).deps.load = async () => {
      throw new Error("not a drawing");
    };
    t.setDisk([el("a"), el("b")]);
    await t.session.reload();
    expect(t.problems[0]).toContain("Could not reload");
    expect(t.canvas.updates).toEqual([]);
  });

  it("ignores canvas changes while the draw-in runs, so frames are never saved", async () => {
    const t = await opened([el("a")]);
    t.setDisk([el("a"), el("b")]);
    await t.session.reload();
    t.session.handleChange(t.canvas.updates[0]!.elements!, { viewBackgroundColor: "#ffffff" }, {});
    expect(t.session.hasUnsavedChanges).toBe(false);
    expect(t.due()).toEqual([]);
  });
});

describe("canvases sharing one session", () => {
  const bg = { viewBackgroundColor: "#ffffff" };

  it("an edit in one canvas shows in the other, with one save", async () => {
    const t = await opened([el("a")]);
    const other = new FakeCanvas();
    other.elements = [el("a")];
    t.session.attach(other);

    t.session.handleChange([el("a"), el("b")], bg, {}, t.canvas);
    expect(other.elements.map((e) => e.id)).toEqual(["a", "b"]);
    expect(other.updates[0]!.captureUpdate).toBe(NEVER); // not an undo step there

    // the other canvas echoes what it now holds: nothing new to share or save
    t.session.handleChange(other.elements, bg, {}, other);
    expect(t.canvas.updates).toEqual([]);
    await t.session.flush();
    expect(t.save).toHaveBeenCalledTimes(1);
  });

  it("a deletion travels too, and the canvas that made the edit is left alone", async () => {
    const t = await opened([el("a"), el("b")]);
    const other = new FakeCanvas();
    other.elements = [el("a"), el("b")];
    t.session.attach(other);
    const edited = [el("a"), el("b", 2, { isDeleted: true })];
    t.session.handleChange(edited, bg, {}, t.canvas);
    expect(other.elements.find((e) => e.id === "b")!.isDeleted).toBe(true);
    expect(t.canvas.updates).toEqual([]);
  });

  it("a reload from outside reaches every canvas", async () => {
    const t = await opened([el("a")]);
    const other = new FakeCanvas();
    other.elements = [el("a")];
    t.session.attach(other);
    t.setDisk([el("a"), el("n")]);
    const reloaded = t.session.reload();
    await reloaded;
    t.advance(1000);
    await vi.waitFor(() => expect(other.elements.map((e) => e.id)).toEqual(["a", "n"]));
    expect(t.canvas.elements.map((e) => e.id)).toEqual(["a", "n"]);
  });

  it("a canvas that joins starts from the unsaved edits, and one that leaves is not touched", async () => {
    const t = await opened([el("a")]);
    t.session.handleChange([el("a"), el("b")], bg, {}, t.canvas);
    const joined = t.session.initial();
    expect(joined.elements.map((e) => e.id)).toEqual(["a", "b"]);

    const other = new FakeCanvas();
    const detach = t.session.attach(other);
    detach();
    t.session.handleChange([el("a"), el("b"), el("c")], bg, {}, t.canvas);
    expect(other.updates).toEqual([]);
  });

  it("a reload that comes while no canvas shows the file is applied when one attaches", async () => {
    const t = setup([el("a")]);
    await t.session.open();
    t.setDisk([el("a"), el("n")]);
    await t.session.reload(); // nobody to show it to
    t.canvas.elements = [el("a")];
    t.session.attach(t.canvas);
    t.advance(1000);
    await vi.waitFor(() => expect(t.canvas.elements.map((e) => e.id)).toEqual(["a", "n"]));
  });
});
