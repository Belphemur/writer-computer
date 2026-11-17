// The registry a mounted component uses to take vault files dragged from the sidebar by pointer
// (`lib/vault-drop-target.ts`): the drag asks by screen position; nothing registered, nothing taken.
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { dropVaultFilesOnTarget, registerVaultDropTarget } from "@/lib/vault-drop-target";

const target = (over: Partial<Parameters<typeof registerVaultDropTarget>[0]> = {}) => ({
  contains: vi.fn(() => true),
  attachVaultFiles: vi.fn(),
  ...over,
});
const unregister: Array<() => void> = [];
afterEach(() => unregister.splice(0).forEach((u) => u()));

describe("vault drop target", () => {
  it("takes nothing without a registered target", () => {
    expect(dropVaultFilesOnTarget(1, 2, ["a.png"])).toBe(false);
  });

  it("hands the paths to the target under the point", () => {
    const t = target();
    unregister.push(registerVaultDropTarget(t));
    expect(dropVaultFilesOnTarget(10, 20, ["a.png", "b.png"])).toBe(true);
    expect(t.contains).toHaveBeenCalledWith(10, 20);
    expect(t.attachVaultFiles).toHaveBeenCalledWith(["a.png", "b.png"]);
  });

  it("leaves a drop elsewhere alone", () => {
    const t = target({ contains: vi.fn(() => false) });
    unregister.push(registerVaultDropTarget(t));
    expect(dropVaultFilesOnTarget(0, 0, ["a.png"])).toBe(false);
    expect(t.attachVaultFiles).not.toHaveBeenCalled();
  });

  it("unregisters only itself: an older unregister cannot remove a newer target", () => {
    const first = target();
    const second = target();
    const offFirst = registerVaultDropTarget(first);
    unregister.push(registerVaultDropTarget(second));
    offFirst();
    expect(dropVaultFilesOnTarget(0, 0, ["a.png"])).toBe(true);
    expect(second.attachVaultFiles).toHaveBeenCalled();
    expect(first.attachVaultFiles).not.toHaveBeenCalled();
  });
});
