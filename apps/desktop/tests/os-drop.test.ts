// The one OS drop dispatcher (`lib/os-drop`): the position conversion (the root cause of the
// broken composer drop) and the choice of the target under the pointer.
import { describe, expect, it, vi } from "vite-plus/test";
import { createOsDropHandler, dropPoint, registerOsDropTarget } from "@/lib/os-drop";

const event = (type: "enter" | "over" | "drop" | "leave", x = 0, y = 0, paths: string[] = []) =>
  ({ type, paths, position: { x, y } }) as never;

describe("drop position", () => {
  it("macOS and Linux report CSS pixels already: a Retina ratio must not halve them", () => {
    // The pointer is at (300, 700) CSS px on a 2x screen; wry reports (300, 700), not (600, 1400).
    expect(dropPoint({ x: 300, y: 700 }, "macos", 2)).toEqual({ x: 300, y: 700 });
    expect(dropPoint({ x: 300, y: 700 }, "linux", 2)).toEqual({ x: 300, y: 700 });
  });

  it("Windows reports physical pixels: they are divided by the ratio", () => {
    expect(dropPoint({ x: 600, y: 1400 }, "windows", 2)).toEqual({ x: 300, y: 700 });
    expect(dropPoint({ x: 150, y: 150 }, "windows", 1.5)).toEqual({ x: 100, y: 100 });
  });
});

describe("dispatching", () => {
  const box = (left: number, top: number, right: number, bottom: number) => ({
    contains: ({ x, y }: { x: number; y: number }) =>
      x >= left && x <= right && y >= top && y <= bottom,
    hover: vi.fn(),
    drop: vi.fn(),
  });

  it("a drop at the composer's CSS point reaches it on a 2x macOS screen (the regression)", () => {
    // composer at the bottom right of a 1000x800 window, 2x: Tauri sends points
    const composer = box(600, 650, 1000, 800);
    const off = registerOsDropTarget(composer);
    const handle = createOsDropHandler("macos", () => 2);
    handle(event("enter", 800, 720, ["/Users/me/a.png"]));
    handle(event("drop", 800, 720, ["/Users/me/a.png"]));
    expect(composer.drop).toHaveBeenCalledWith({ x: 800, y: 720 }, ["/Users/me/a.png"]);
    off();
  });

  it("goes to the target under the point only, hovers it, and tells the previous one it left", () => {
    const a = box(0, 0, 100, 100);
    const b = box(200, 0, 300, 100);
    const offs = [registerOsDropTarget(a), registerOsDropTarget(b)];
    const handle = createOsDropHandler("macos");
    handle(event("enter", 50, 50, ["/x/f"]));
    expect(a.hover).toHaveBeenLastCalledWith({ x: 50, y: 50 }, ["/x/f"]);
    handle(event("over", 250, 50));
    expect(a.hover).toHaveBeenLastCalledWith(null, []);
    expect(b.hover).toHaveBeenLastCalledWith({ x: 250, y: 50 }, ["/x/f"]);
    handle(event("leave"));
    expect(b.hover).toHaveBeenLastCalledWith(null, []);
    handle(event("drop", 250, 50, ["/x/f"]));
    expect(b.drop).toHaveBeenCalledOnce();
    expect(a.drop).not.toHaveBeenCalled();
    offs.forEach((o) => o());
  });

  it("a drop on no target, or with no paths, does nothing", () => {
    const a = box(0, 0, 10, 10);
    const off = registerOsDropTarget(a);
    const handle = createOsDropHandler("macos");
    handle(event("drop", 500, 500, ["/x/f"]));
    handle(event("drop", 5, 5, []));
    expect(a.drop).not.toHaveBeenCalled();
    off();
  });
});
