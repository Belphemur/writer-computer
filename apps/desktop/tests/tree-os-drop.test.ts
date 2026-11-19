// @vitest-environment jsdom
// Finder items dropped on the sidebar tree (`use-tree-os-drop`): the folder under the pointer, the
// import through Rust, and a vault item moved (links rewritten) instead of copied.
import { describe, expect, it, vi } from "vite-plus/test";
import { folderAtPoint } from "../src/components/sidebar/tree-move";
import { importDropped, type TreeDropDeps } from "../src/components/sidebar/use-tree-os-drop";
import type { DropOutcome } from "../src/lib/tauri";
import type { DirEntry } from "../src/types/fs";

const entry = (path: string, is_dir: boolean): DirEntry => ({
  name: path.split("/").pop()!,
  path,
  is_dir,
  is_markdown: path.endsWith(".md"),
  modified_at: 0,
  created_at: 0,
  title: null,
});

/** A tree of two rows, 20px tall each: a folder `/v/docs` and a note `/v/a.md`, in a 100x100 box. */
function tree() {
  const container = document.createElement("div");
  container.getBoundingClientRect = () => ({ left: 0, right: 100, top: 0, bottom: 100 }) as DOMRect;
  const rows: [string, number][] = [
    ["/v/docs", 0],
    ["/v/docs/in.md", 20],
    ["/v/a.md", 40],
  ];
  for (const [path, top] of rows) {
    const row = document.createElement("div");
    row.setAttribute("data-tree-path", path);
    row.getBoundingClientRect = () => ({ left: 0, right: 100, top, bottom: top + 19 }) as DOMRect;
    container.appendChild(row);
  }
  const entries = new Map([
    ["/v/docs", entry("/v/docs", true)],
    ["/v/docs/in.md", entry("/v/docs/in.md", false)],
    ["/v/a.md", entry("/v/a.md", false)],
  ]);
  return { container, entries };
}

describe("where a Finder drop lands in the tree", () => {
  it("onto a folder row it is that folder, onto a file row that file's folder, onto empty space the root", () => {
    const { container, entries } = tree();
    expect(folderAtPoint(container, entries, "/v", 10, 5)).toBe("/v/docs");
    expect(folderAtPoint(container, entries, "/v", 10, 25)).toBe("/v/docs");
    expect(folderAtPoint(container, entries, "/v", 10, 45)).toBe("/v");
    // below the last row (empty space) is the last row's folder band end: the root for a root file
    expect(folderAtPoint(container, entries, "/v", 10, 90)).toBe("/v");
  });

  it("outside the tree it is nothing", () => {
    const { container, entries } = tree();
    expect(folderAtPoint(container, entries, "/v", 150, 5)).toBeNull();
    expect(folderAtPoint(container, entries, "/v", 10, -5)).toBeNull();
  });
});

describe("importDropped", () => {
  const deps = (over: Partial<TreeDropDeps> = {}) => ({
    rootPath: "/v",
    dropImport: vi.fn(),
    moveEntry: vi.fn(),
    refreshDirectory: vi.fn(),
    select: vi.fn(),
    notify: vi.fn(),
    ...over,
  });

  it("copies outside files and folders into the folder, refreshes it and selects the new items", async () => {
    const d = deps({
      dropImport: vi.fn(async (): Promise<DropOutcome[]> => [
        { kind: "copied", path: "docs/a.txt", isDir: false, files: 1, skipped: 0 },
        { kind: "copied", path: "docs/proj", isDir: true, files: 4, skipped: 0 },
      ]),
    });
    await importDropped("/v/docs", ["/Users/me/a.txt", "/Users/me/proj"], d);
    expect(d.dropImport).toHaveBeenCalledWith("/v/docs", ["/Users/me/a.txt", "/Users/me/proj"]);
    expect(d.refreshDirectory).toHaveBeenCalledWith("/v/docs");
    expect(d.select).toHaveBeenCalledWith(["/v/docs/a.txt", "/v/docs/proj"]);
    expect(d.notify).not.toHaveBeenCalled();
    expect(d.moveEntry).not.toHaveBeenCalled();
  });

  it("a vault file dragged from Finder is moved through the move path (links rewritten), not copied", async () => {
    const d = deps({
      dropImport: vi.fn(async (): Promise<DropOutcome[]> => [
        { kind: "inVault", path: "a.md", isDir: false },
      ]),
      moveEntry: vi.fn(async (e: DirEntry) => ({
        status: "moved" as const,
        entry: e,
        newPath: "/v/docs/a.md",
      })),
    });
    await importDropped("/v/docs", ["/v/a.md"], d);
    expect(d.moveEntry).toHaveBeenCalledOnce();
    expect(d.moveEntry).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/v/a.md", name: "a.md", is_dir: false }),
      "/v/docs",
    );
    expect(d.select).toHaveBeenCalledWith(["/v/docs/a.md"]);
  });

  it("one notice for refusals and for the secret files left out of a tree, the rest still land", async () => {
    const d = deps({
      dropImport: vi.fn(async (): Promise<DropOutcome[]> => [
        { kind: "copied", path: "proj", isDir: true, files: 3, skipped: 2 },
        { kind: "refused", name: ".env", message: ".env looks like a secret" },
        { kind: "refused", name: "huge", message: "that folder is over 500 MB" },
      ]),
    });
    await importDropped("/v", ["/x/proj", "/x/.env", "/x/huge"], d);
    expect(d.select).toHaveBeenCalledWith(["/v/proj"]);
    expect(d.notify).toHaveBeenCalledOnce();
    expect(d.notify).toHaveBeenCalledWith(
      "Not added: .env looks like a secret; huge: that folder is over 500 MB; Skipped 2 secret-looking files",
    );
  });

  it("a failed import is a notice and touches nothing", async () => {
    const d = deps({
      dropImport: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    await importDropped("/v", ["/x/a"], d);
    expect(d.notify).toHaveBeenCalledWith("Not added: boom");
    expect(d.refreshDirectory).not.toHaveBeenCalled();
  });
});
