import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const m = vi.hoisted(() => ({
  open: new Set<string>(),
  root: "/vault" as string | null,
  reload: vi.fn(),
  read: vi.fn(async (_p: string) => ({ path: "", content: "---\nnew\n---", modified_at: 0 })),
}));
vi.mock("../src/hooks/editor-api", () => ({
  getOpenFile: (p: string) => (m.open.has(p) ? {} : null),
  reloadFromDisk: (p: string, c: string) => m.reload(p, c),
}));
vi.mock("../src/hooks/workspace-api", () => ({ getWorkspaceRoot: () => m.root }));
vi.mock("../src/lib/tauri", () => ({ readFile: (p: string) => m.read(p) }));

import { reloadChatNoteIfOpen } from "../src/lib/agent/chat-editor-sync";

describe("reloading a saved chat note in an open editor tab", () => {
  beforeEach(() => {
    m.open.clear();
    m.root = "/vault";
    m.reload.mockClear();
    m.read.mockClear();
  });

  it("re-reads the note and hands it to the editor when its tab is open", async () => {
    m.open.add("/vault/Projects/Demo/.chats/a.md");
    expect(await reloadChatNoteIfOpen("Projects/Demo/.chats/a.md")).toBe(true);
    expect(m.read).toHaveBeenCalledWith("/vault/Projects/Demo/.chats/a.md");
    expect(m.reload).toHaveBeenCalledWith("/vault/Projects/Demo/.chats/a.md", "---\nnew\n---");
  });

  it("does nothing, and reads nothing, when no tab shows the note or there is no vault", async () => {
    expect(await reloadChatNoteIfOpen("x/.chats/a.md")).toBe(false);
    m.root = null;
    expect(await reloadChatNoteIfOpen("x/.chats/a.md")).toBe(false);
    expect(m.read).not.toHaveBeenCalled();
    expect(m.reload).not.toHaveBeenCalled();
  });

  it("copes with a vault root that ends in a slash", async () => {
    m.root = "/vault/";
    m.open.add("/vault/a/.chats/b.md");
    expect(await reloadChatNoteIfOpen("a/.chats/b.md")).toBe(true);
  });
});
