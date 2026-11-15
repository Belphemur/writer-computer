import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  deserializeLocation,
  locationForPath,
  opensAsDocument,
  pageKind,
  serializeLocation,
} from "../src/components/editor-area/page-kinds";
import { pageKindView } from "../src/components/editor-area/page-kinds/views";
import { getEditorSessionSnapshot, useEditorStore } from "../src/stores/editor-store";
import { resolveWikiLink } from "../src/lib/wiki-links";

const mockedInvoke = vi.mocked(invoke);

function resetStore() {
  useEditorStore.setState({
    openFiles: new Map(),
    tabs: [],
    activeTabId: null,
    activeFilePath: null,
  });
}

function readFileCalls() {
  return mockedInvoke.mock.calls.filter(([cmd]) => cmd === "read_file").map(([, args]) => args);
}

describe("base page kind", () => {
  const location = { kind: "base" as const, path: "/v/Projects/tasks.base" };

  it("titles the tab after the file without the extension and references its path", () => {
    const k = pageKind(location);
    expect(k.title(location)).toBe("tasks");
    expect(k.paths(location)).toEqual(["/v/Projects/tasks.base"]);
    expect(k.primaryPath(location)).toBe("/v/Projects/tasks.base");
    expect(k.keepAlive).toBe(true);
    expect(k.loadsDocument).toBe(false);
  });

  it("round-trips through the session payload, keeping the selected view", () => {
    expect(serializeLocation(location)).toEqual({ kind: "base", path: location.path });
    expect(deserializeLocation(serializeLocation(location))).toEqual(location);
    const withView = { ...location, view: "Board" };
    expect(serializeLocation(withView)).toEqual({
      kind: "base",
      path: location.path,
      view: "Board",
    });
    expect(deserializeLocation(serializeLocation(withView))).toEqual(withView);
    expect(deserializeLocation({ kind: "base" })).toBeNull();
  });

  it("follows renames and deletes", () => {
    const k = pageKind(location);
    expect(k.rewritePath(location, location.path, "/v/new.base")).toEqual({
      ...location,
      path: "/v/new.base",
    });
    expect(k.rewritePath(location, "/v/other.base", "/v/new.base")).toBe(location);
    expect(k.removePath(location, location.path)).toBeNull();
    expect(k.removePath(location, "/v/other.base")).toBe(location);
  });

  it("has a registered view", () => {
    expect(pageKindView(location).Component).toBeTypeOf("function");
  });
});

describe("locationForPath", () => {
  it("routes by extension through the registry", () => {
    expect(locationForPath("/v/a.base")).toEqual({ kind: "base", path: "/v/a.base" });
    expect(locationForPath("/v/A.BASE")).toEqual({ kind: "base", path: "/v/A.BASE" });
    expect(locationForPath("/v/a.md")).toEqual({ kind: "file", path: "/v/a.md" });
    expect(locationForPath("/v/a.base.md")).toEqual({ kind: "file", path: "/v/a.base.md" });
  });

  it("knows which paths are loaded as text documents", () => {
    expect(opensAsDocument("/v/a.md")).toBe(true);
    expect(opensAsDocument("/v/a.base")).toBe(false);
  });
});

describe("opening a base in the editor store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
    mockedInvoke.mockImplementation(async (cmd, args) => {
      if (cmd === "read_file") {
        const path = (args as { path: string }).path;
        return { path, content: `# ${path}`, modified_at: 0 };
      }
      return undefined;
    });
  });

  it("opens a .base as a base tab without reading it as text", async () => {
    await useEditorStore.getState().openFile("/v/tasks.base");
    const { tabs, openFiles, activeFilePath } = useEditorStore.getState();
    expect(tabs).toHaveLength(1);
    expect(tabs[0]!.location).toEqual({ kind: "base", path: "/v/tasks.base" });
    expect(openFiles.size).toBe(0);
    expect(activeFilePath).toBe("/v/tasks.base");
    expect(readFileCalls()).toEqual([]);
  });

  it("opens a .base in a new tab", async () => {
    await useEditorStore.getState().openFileInNewTab("/v/tasks.base");
    expect(useEditorStore.getState().tabs[0]!.location.kind).toBe("base");
    expect(readFileCalls()).toEqual([]);
  });

  it("opens a .base as text on request (Edit YAML), loading it once and focusing the tab after", async () => {
    await useEditorStore.getState().openFile("/v/tasks.base");
    await useEditorStore.getState().openFileAsTextInNewTab("/v/tasks.base");
    let { tabs, openFiles, activeTabId } = useEditorStore.getState();
    expect(tabs.map((t) => t.location.kind)).toEqual(["base", "file"]);
    expect(activeTabId).toBe(tabs[1]!.id);
    expect(openFiles.get("/v/tasks.base")!.content).toBe("# /v/tasks.base");
    expect(readFileCalls()).toEqual([{ path: "/v/tasks.base" }]);
    // A second request focuses the existing text tab instead of opening another.
    useEditorStore.getState().setActiveTab(tabs[0]!.id);
    await useEditorStore.getState().openFileAsTextInNewTab("/v/tasks.base");
    ({ tabs, activeTabId } = useEditorStore.getState());
    expect(tabs).toHaveLength(2);
    expect(activeTabId).toBe(tabs[1]!.id);
  });

  it("restores a text tab of a .base from the session by reading it as text", async () => {
    await useEditorStore.getState().restoreSession(
      [
        { location: { kind: "base", path: "/v/tasks.base" }, back: [], forward: [] },
        { location: { kind: "file", path: "/v/tasks.base" }, back: [], forward: [] },
      ],
      1,
    );
    expect([...useEditorStore.getState().openFiles.keys()]).toEqual(["/v/tasks.base"]);
    expect(readFileCalls()).toEqual([{ path: "/v/tasks.base" }]);
  });

  it("navigates in place between a note and a base, with history, loading only the note", async () => {
    await useEditorStore.getState().openFile("/v/a.md");
    expect(readFileCalls()).toEqual([{ path: "/v/a.md" }]);
    await useEditorStore.getState().navigateToFile("/v/tasks.base");
    let tab = useEditorStore.getState().tabs[0]!;
    expect(tab.location).toEqual({ kind: "base", path: "/v/tasks.base" });
    expect(tab.back).toEqual([{ kind: "file", path: "/v/a.md" }]);
    expect(useEditorStore.getState().tabs).toHaveLength(1);

    // From a base tab, opening a note navigates the same tab.
    await useEditorStore.getState().openFile("/v/b.md");
    tab = useEditorStore.getState().tabs[0]!;
    expect(tab.location).toEqual({ kind: "file", path: "/v/b.md" });
    expect(useEditorStore.getState().tabs).toHaveLength(1);

    await useEditorStore.getState().navigateBack();
    expect(useEditorStore.getState().tabs[0]!.location.kind).toBe("base");
    expect(readFileCalls().some((c) => (c as { path: string }).path.endsWith(".base"))).toBe(false);
  });

  it("restores a base tab from the session without reading it", async () => {
    await useEditorStore.getState().restoreSession(
      [
        { location: { kind: "base", path: "/v/tasks.base", view: "Board" }, back: [], forward: [] },
        { location: { kind: "file", path: "/v/a.md" }, back: [], forward: [] },
      ],
      0,
    );
    const { tabs, activeFilePath, openFiles } = useEditorStore.getState();
    expect(tabs[0]!.location).toEqual({ kind: "base", path: "/v/tasks.base", view: "Board" });
    expect(activeFilePath).toBe("/v/tasks.base");
    expect([...openFiles.keys()]).toEqual(["/v/a.md"]);
    expect(readFileCalls()).toEqual([{ path: "/v/a.md" }]);
  });

  it("round-trips the selected view through the session snapshot", async () => {
    await useEditorStore.getState().openFile("/v/tasks.base");
    const tabId = useEditorStore.getState().tabs[0]!.id;
    useEditorStore.getState().setBaseTabView(tabId, "Board");
    const snapshot = getEditorSessionSnapshot(useEditorStore.getState());
    expect(snapshot.tabs[0]!.location).toEqual({
      kind: "base",
      path: "/v/tasks.base",
      view: "Board",
    });
    useEditorStore.getState().setBaseTabView(tabId, undefined);
    expect(useEditorStore.getState().tabs[0]!.location).toEqual({
      kind: "base",
      path: "/v/tasks.base",
    });
  });

  it("setBaseTabView bails out when nothing changes and ignores other kinds", async () => {
    await useEditorStore.getState().openFile("/v/a.md");
    const before = useEditorStore.getState().tabs;
    useEditorStore.getState().setBaseTabView(before[0]!.id, "Board");
    expect(useEditorStore.getState().tabs).toBe(before);
  });

  it("re-points and closes base tabs on rename and delete", async () => {
    await useEditorStore.getState().openFile("/v/tasks.base");
    useEditorStore.getState().renameOpenFile("/v/tasks.base", "/v/work.base");
    expect(useEditorStore.getState().tabs[0]!.location).toEqual({
      kind: "base",
      path: "/v/work.base",
    });
    expect(useEditorStore.getState().activeFilePath).toBe("/v/work.base");

    useEditorStore.getState().rewritePathPrefix("/v", "/w");
    expect(useEditorStore.getState().tabs[0]!.location).toMatchObject({ path: "/w/work.base" });

    useEditorStore.getState().removePathReferences("/w/work.base");
    expect(useEditorStore.getState().tabs.map((t) => t.location.kind)).toEqual(["launcher"]);
  });

  it("closeFile and setActiveFile address a base tab by path", async () => {
    await useEditorStore.getState().openFile("/v/tasks.base");
    await useEditorStore.getState().openFileInNewTab("/v/a.md");
    useEditorStore.getState().setActiveFile("/v/tasks.base");
    expect(useEditorStore.getState().activeFilePath).toBe("/v/tasks.base");
    useEditorStore.getState().closeFile("/v/tasks.base");
    expect(useEditorStore.getState().tabs.map((t) => t.location.kind)).toEqual(["file"]);
  });
});

describe("wiki links to bases", () => {
  const never = async () => [];
  const exists = (paths: string[]) => async (p: string) => paths.includes(p);

  it("resolves [[folder/x.base#View]] to the file and carries the view as fragment", async () => {
    const result = await resolveWikiLink(
      "Projects/tasks.base#Board",
      "/v",
      never,
      exists(["/v/Projects/tasks.base"]),
    );
    expect(result).toEqual({
      kind: "internal",
      path: "/v/Projects/tasks.base",
      fragment: "Board",
    });
  });

  it("finds a bare [[x.base]] by file name", async () => {
    const find = vi.fn(async (name: string) =>
      name === "tasks.base" ? "/v/deep/tasks.base" : null,
    );
    expect(await resolveWikiLink("tasks.base", "/v", never, exists([]), null, find)).toEqual({
      kind: "internal",
      path: "/v/deep/tasks.base",
    });
    expect(await resolveWikiLink("missing.base", "/v", never, exists([]), null, find)).toEqual({
      kind: "unresolved",
    });
    expect(await resolveWikiLink("tasks.base", "/v", never, exists([]))).toEqual({
      kind: "unresolved",
    });
  });

  it("leaves note links unchanged", async () => {
    const found = [
      { path: "/v/n.md", filename: "n.md", relative_path: "n.md", score: 1, match_indices: [] },
    ];
    expect(await resolveWikiLink("n", "/v", async () => found, exists([]))).toEqual({
      kind: "internal",
      path: "/v/n.md",
    });
  });
});
