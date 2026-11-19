// The draw-in of reloaded drawings: only elements that are new are touched, a stroke is revealed
// along its path and the rest fade in, the last frame is the elements themselves, and reduced
// motion animates nothing.
import { describe, expect, it, vi } from "vite-plus/test";
import { DRAW_IN_MS, drawInFrame, partialPoints, planDrawIn, runDrawIn } from "../web/lib/draw-in";
import type { SceneElement } from "../web/lib/excalidraw-md";

const box = (id: string): SceneElement => ({ id, type: "rectangle", opacity: 100 });
const arrow = (id: string): SceneElement => ({
  id,
  type: "arrow",
  opacity: 100,
  points: [
    [0, 0],
    [100, 0],
    [100, 100],
  ],
});

describe("drawInFrame", () => {
  it("leaves every element that is not new exactly as it is", () => {
    const old = box("old");
    const out = drawInFrame([old, box("new"), arrow("arr")], new Set(["new", "arr"]), 0.4);
    expect(out[0]).toBe(old);
    expect(out[1]!.opacity).toBeLessThan(100);
    expect(out[1]!.opacity).toBeGreaterThan(0);
    expect((out[2]!.points as number[][]).length).toBeGreaterThanOrEqual(2);
  });

  it("starts empty, ends on the elements themselves", () => {
    const els = [box("n"), arrow("a")];
    const first = drawInFrame(els, new Set(["n", "a"]), 0);
    expect(first[0]!.opacity).toBe(0);
    expect(first[1]!.points).toEqual([
      [0, 0],
      [0, 0],
    ]);
    expect(drawInFrame(els, new Set(["n", "a"]), 1)).toBe(els);
  });

  it("reveals a path by length, ending at the last point", () => {
    const pts = arrow("a").points as [number, number][];
    expect(partialPoints(pts, 0.25)).toEqual([
      [0, 0],
      [50, 0],
    ]);
    expect(partialPoints(pts, 0.75)).toEqual([
      [0, 0],
      [100, 0],
      [100, 50],
    ]);
    expect(partialPoints(pts, 1)).toEqual(pts);
  });
});

describe("planDrawIn", () => {
  it("animates the added ids, and none with reduced motion", () => {
    expect([...planDrawIn(new Set(["a", "b"]), false)]).toEqual(["a", "b"]);
    expect(planDrawIn(new Set(["a", "b"]), true).size).toBe(0);
  });
});

describe("runDrawIn", () => {
  function clock() {
    let t = 0;
    const queue: ((n: number) => void)[] = [];
    return {
      now: () => t,
      raf: (cb: (n: number) => void) => queue.push(cb),
      caf: () => {},
      tick(ms: number) {
        t += ms;
        queue.splice(0).forEach((cb) => cb(t));
      },
    };
  }

  it("shows frames for about 300 ms and ends on the real elements", () => {
    const c = clock();
    const els = [box("n")];
    const show = vi.fn();
    const done = vi.fn();
    runDrawIn(els, new Set(["n"]), { show, ...c }, done);
    expect(show).toHaveBeenCalledTimes(1);
    expect(show.mock.calls[0]![0][0].opacity).toBe(0);
    c.tick(100);
    c.tick(100);
    expect(done).not.toHaveBeenCalled();
    c.tick(DRAW_IN_MS);
    expect(show.mock.calls.at(-1)![0]).toBe(els);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("finish() jumps to the elements at once, once", () => {
    const c = clock();
    const els = [box("n")];
    const show = vi.fn();
    const done = vi.fn();
    const run = runDrawIn(els, new Set(["n"]), { show, ...c }, done);
    run.finish();
    run.finish();
    expect(show.mock.calls.at(-1)![0]).toBe(els);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("with nothing new it shows the elements and is done, no frames", () => {
    const show = vi.fn();
    const els = [box("n")];
    runDrawIn(els, new Set(), { show, ...clock() });
    expect(show).toHaveBeenCalledTimes(1);
    expect(show.mock.calls[0]![0]).toBe(els);
  });
});
