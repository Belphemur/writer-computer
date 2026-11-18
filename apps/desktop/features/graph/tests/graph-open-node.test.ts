// Every node click goes through `src/lib/link-activation.ts`: left, middle, Cmd/Ctrl and
// Cmd/Ctrl+Shift clicks on a node reach the editor store's one open path with the right intent.
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
const nav = vi.hoisted(() => ({ navigateToFile: vi.fn(), openFileInNewTab: vi.fn() }));
vi.mock("@/hooks/editor-api", () => ({
  ...nav,
  openGraphTab: vi.fn(),
  getActiveFilePath: () => null,
}));
vi.mock("@/hooks/workspace-api", () => ({ getWorkspaceRoot: () => "/vault" }));
vi.mock("@/lib/platform", () => ({ detectPlatform: () => "macos" }));

import { intentOf, nodeClick, openNode, attachToAgent } from "../web/actions";

const node = { kind: "note" as const, path: "People/Ana.md", label: "Ana" };
const click = (init: MouseEventInit) => new MouseEvent("click", init);

beforeEach(() => vi.clearAllMocks());

describe("node click gestures", () => {
  it.each([
    ["left click", { button: 0 }, "current"],
    ["middle click", { button: 1 }, "new-tab-background"],
    ["Cmd+click", { button: 0, metaKey: true }, "new-tab-background"],
    ["Cmd+Shift+click", { button: 0, metaKey: true, shiftKey: true }, "new-tab-active"],
  ] as const)("%s", async (_name, init, expected) => {
    const intent = intentOf(click(init));
    expect(intent).toBe(expected);
    await openNode(node, intent!);
    const abs = "/vault/People/Ana.md";
    if (expected === "current") expect(nav.navigateToFile).toHaveBeenCalledWith(abs);
    else
      expect(nav.openFileInNewTab).toHaveBeenCalledWith(abs, {
        activate: expected === "new-tab-active",
      });
  });

  it("a plain click selects, Shift+click toggles, modified clicks open", () => {
    const none = new Set<string>();
    expect(nodeClick("current", false, new Set(["b.md"]), "a.md")).toEqual({
      selection: new Set(["a.md"]),
    });
    expect(nodeClick("current", true, new Set(["b.md"]), "a.md")).toEqual({
      selection: new Set(["b.md", "a.md"]),
    });
    expect(nodeClick("current", true, new Set(["a.md"]), "a.md")).toEqual({ selection: none });
    expect(nodeClick("new-tab-background", false, none, "a.md")).toEqual({
      open: "new-tab-background",
    });
    expect(nodeClick("new-tab-active", false, none, "a.md")).toEqual({ open: "new-tab-active" });
  });

  it("a right click is not an open", () => {
    expect(intentOf(click({ button: 2 }))).toBeNull();
  });

  it("tags open nothing", async () => {
    await openNode({ kind: "tag", path: "", label: "#x" }, "current");
    expect(nav.navigateToFile).not.toHaveBeenCalled();
  });

  it("attach is unavailable while the agent feature is off", async () => {
    expect(await attachToAgent(["a.md"])).toBe(false);
  });
});
