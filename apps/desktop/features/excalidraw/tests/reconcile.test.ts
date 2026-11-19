// Live reload merges the file into the canvas by id and version (ADR 2026-11-18, point 9): the
// user's unsaved edit beats an older copy on disk, what an agent added arrives, what an agent
// removed goes unless the user changed it, and the user's own additions stay.
import { describe, expect, it } from "vite-plus/test";
import type { SceneElement } from "../web/lib/excalidraw-md";
import { baseOf, reconcile } from "../web/lib/reconcile";

const el = (id: string, version = 1, extra: Partial<SceneElement> = {}): SceneElement => ({
  id,
  type: "rectangle",
  version,
  versionNonce: 100,
  isDeleted: false,
  ...extra,
});
const ids = (xs: SceneElement[]) => xs.map((e) => e.id);

describe("reconcile", () => {
  it("brings in what is new on disk and reports it as added", () => {
    const local = [el("a")];
    const m = reconcile(local, [el("a"), el("b"), el("c")], baseOf(local));
    expect(ids(m.elements)).toEqual(["a", "b", "c"]);
    expect([...m.added]).toEqual(["b", "c"]);
    expect(m.changed).toBe(true);
  });

  it("the higher version wins, whichever side it is on", () => {
    const m = reconcile(
      [el("a", 3, { x: 1 }), el("b", 1, { x: 1 })],
      [el("a", 2, { x: 2 }), el("b", 2, { x: 2 })],
      baseOf([el("a", 2), el("b", 1)]),
    );
    const byId = Object.fromEntries(m.elements.map((e) => [e.id, e.x]));
    expect(byId).toEqual({ a: 1, b: 2 });
  });

  it("on equal versions the lower versionNonce wins, so both sides settle the same way", () => {
    const mine = el("a", 2, { versionNonce: 5, x: "mine" });
    const theirs = el("a", 2, { versionNonce: 9, x: "theirs" });
    expect(reconcile([mine], [theirs], baseOf([mine])).elements[0]!.x).toBe("mine");
    expect(reconcile([theirs], [mine], baseOf([theirs])).elements[0]!.x).toBe("mine");
  });

  it("keeps the user's unsaved edit over an older copy and the unsaved addition", () => {
    const saved = [el("a", 1)];
    const local = [el("a", 2, { x: "edited" }), el("mine", 1)];
    const m = reconcile(local, [el("a", 1), el("b", 1)], baseOf(saved));
    expect(ids(m.elements)).toEqual(["a", "b", "mine"]);
    expect(m.elements[0]!.x).toBe("edited");
    expect(m.added.has("mine")).toBe(false);
    expect([...m.added]).toEqual(["b"]);
  });

  it("an element removed from disk goes, unless the user changed it since the save", () => {
    const saved = [el("a", 1), el("b", 1)];
    const local = [el("a", 1), el("b", 2)];
    const m = reconcile(local, [], baseOf(saved));
    const state = Object.fromEntries(m.elements.map((e) => [e.id, e.isDeleted]));
    expect(state).toEqual({ a: true, b: false });
    expect(m.changed).toBe(true);
  });

  it("an unchanged file changes nothing", () => {
    const local = [el("a"), el("b", 4)];
    const m = reconcile(local, [el("a"), el("b", 4)], baseOf(local));
    expect(m.changed).toBe(false);
    expect(m.added.size).toBe(0);
    expect(ids(m.elements)).toEqual(["a", "b"]);
  });

  it("a long text id on the canvas and its short form on disk are one element", () => {
    const long = "abcdefghijklmnopqrstu";
    const local = [el(long, 1, { type: "text" })];
    const m = reconcile(local, [el("abcdefgh", 1, { type: "text" })], baseOf(local));
    expect(ids(m.elements)).toEqual(["abcdefgh"]);
    expect(m.added.size).toBe(0);
    expect(m.changed).toBe(false);
  });
});
