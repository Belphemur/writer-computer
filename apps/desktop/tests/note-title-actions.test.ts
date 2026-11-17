import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { useEditorStore } from "../src/stores/editor-store";
import {
  applyNoteTitle,
  readNoteTitleOverride,
  retitleNote,
  UNSAVED_TITLE_MESSAGE,
} from "../src/lib/note-title-actions";

const mockedInvoke = vi.mocked(invoke);
const RESULT = { old: "A", new: "B", links: 2, files: 1, linksUpdated: true, changed: true };

beforeEach(() => {
  vi.clearAllMocks();
  useEditorStore.setState({
    openFiles: new Map(),
    tabs: [],
    activeTabId: null,
    activeFilePath: null,
  });
});

describe("retitleNote", () => {
  test("sends the title, the link option and the dry-run flag to retitle_note", async () => {
    mockedInvoke.mockResolvedValue(RESULT);
    await retitleNote("/v/N.md", "B", { updateLinks: true, dryRun: true });
    expect(mockedInvoke).toHaveBeenCalledWith("retitle_note", {
      path: "/v/N.md",
      title: "B",
      updateLinks: true,
      dryRun: true,
    });
    await retitleNote("/v/N.md", null, { updateLinks: false, dryRun: false });
    expect(mockedInvoke).toHaveBeenLastCalledWith("retitle_note", {
      path: "/v/N.md",
      title: null,
      updateLinks: false,
      dryRun: false,
    });
  });
});

describe("readNoteTitleOverride", () => {
  test("reads the frontmatter of a closed note and ignores its heading", async () => {
    mockedInvoke.mockResolvedValueOnce({
      path: "/v/N.md",
      content: "---\ntitle: Pretty\n---\n# Heading\n",
      modified_at: 1,
    });
    expect(await readNoteTitleOverride("/v/N.md")).toBe("Pretty");
    mockedInvoke.mockResolvedValueOnce({ path: "/v/M.md", content: "# Heading\n", modified_at: 1 });
    expect(await readNoteTitleOverride("/v/M.md")).toBeNull();
  });
});

describe("applyNoteTitle", () => {
  test("refuses while the open note has unsaved edits and writes nothing", async () => {
    mockedInvoke.mockResolvedValueOnce({ path: "/v/N.md", content: "x", modified_at: 1 });
    await useEditorStore.getState().openFile("/v/N.md");
    useEditorStore.getState().updateContent("/v/N.md", "edited");
    mockedInvoke.mockClear();
    await expect(applyNoteTitle("/v/N.md", "B", true)).rejects.toThrow(UNSAVED_TITLE_MESSAGE);
    expect(mockedInvoke).not.toHaveBeenCalledWith("retitle_note", expect.anything());
  });

  test("applies for a closed note with the link option", async () => {
    mockedInvoke.mockResolvedValue(RESULT);
    const r = await applyNoteTitle("/v/N.md", "B", true);
    expect(r.links).toBe(2);
    expect(mockedInvoke).toHaveBeenCalledWith("retitle_note", {
      path: "/v/N.md",
      title: "B",
      updateLinks: true,
      dryRun: false,
    });
  });
});
