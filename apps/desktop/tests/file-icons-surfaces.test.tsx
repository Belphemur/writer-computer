// @vitest-environment jsdom
// Every surface draws an icon from the one hook (`lib/file-icons.ts`, spec SPECs/icons-spec.md):
// the sidebar tree, the tab strip, links in the editor, in properties, in Bases cells and in the
// agent pane, and the tab menu's contributed items. With no icon every surface looks as it did.
// The note title is tested with the feature (`features/icons/tests`).
import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { act, createElement, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));
const menuNew = vi.hoisted(() => vi.fn());
const menuItemNew = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/menu/menu", () => ({ Menu: { new: menuNew } }));
vi.mock("@tauri-apps/api/menu/predefinedMenuItem", () => ({
  PredefinedMenuItem: { new: vi.fn() },
}));
vi.mock("@tauri-apps/api/menu/menuItem", () => ({ MenuItem: { new: menuItemNew } }));
vi.mock("@tauri-apps/api/menu/submenu", () => ({ Submenu: { new: vi.fn() } }));
const resolveWikiLinkTarget = vi.hoisted(() => vi.fn());
vi.mock("@/lib/tauri", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/tauri")>()),
  resolveWikiLinkTarget,
}));

import { DESKTOP, sourceFiles } from "@tests/helpers/import-graph";
import { CellView } from "@features/bases/web/view/cell-view";
import { useMarkdownLinks } from "@features/agent/web/components/agent-links";
import { EditorTabs } from "@/components/editor-area/editor-tabs";
import { wikiLinkExtension } from "@/components/editor-area/wiki-link-extension";
import { WikiLinkButton } from "@/components/editor-area/property-wikilink";
import { EntryIcon } from "@/components/sidebar/file-tree-icons";
import { clearFileIcons, resetFileIconsForTests, setFileIcons } from "@/lib/file-icons";
import { menuContributions } from "@/lib/features/menus";
import { defineFeature, createFeatureHost } from "@/lib/features/registry";
import { showTabContextMenu } from "@/components/editor-area/editor-context-menu";
import { useEditorStore, type Tab } from "@/stores/editor-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import type { DirEntry } from "@/types/fs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 10))));

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  useWorkspaceStore.setState({ root: "/vault" });
  resetFileIconsForTests();
  resolveWikiLinkTarget.mockReset();
  resolveWikiLinkTarget.mockResolvedValue("/vault/Notes/Idea.md");
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  clearFileIcons();
});

const entry = (path: string, is_dir = false) =>
  ({ name: path.split("/").pop()!, path, is_dir }) as DirEntry;

describe("the sidebar tree", () => {
  it("draws the entry's icon in place of the file or folder glyph, with its colour", async () => {
    setFileIcons([
      { path: "Notes/Idea.md", icon: "emoji:🚀", color: "#ff0000" },
      { path: "Notes", icon: "emoji:📁" },
    ]);
    await act(async () =>
      root.render(
        <>
          <EntryIcon entry={entry("/vault/Notes/Idea.md")} isExpanded={false} />
          <EntryIcon entry={entry("/vault/Notes", true)} isExpanded />
        </>,
      ),
    );
    const glyphs = [...host.querySelectorAll<HTMLElement>("[data-icon-glyph]")];
    expect(glyphs.map((g) => g.textContent)).toEqual(["🚀", "📁"]);
    expect(glyphs[0]!.style.color).toBe("rgb(255, 0, 0)");
    expect(host.querySelector("svg")).toBeNull();
  });

  it("keeps the default glyphs for an entry without an icon", async () => {
    await act(async () =>
      root.render(
        <>
          <EntryIcon entry={entry("/vault/a.md")} isExpanded={false} />
          <EntryIcon entry={entry("/vault/d", true)} isExpanded={false} />
        </>,
      ),
    );
    expect(host.querySelectorAll("[data-icon-glyph]")).toHaveLength(0);
    expect(host.querySelectorAll("svg")).toHaveLength(2);
  });
});

describe("the tab strip", () => {
  const tab = (id: string, path: string, pinned = false): Tab => ({
    id,
    location: { kind: "file", path },
    back: [],
    forward: [],
    ...(pinned ? { pinned: true } : {}),
  });
  const seed = (tabs: Tab[]) =>
    useEditorStore.setState({
      openFiles: new Map(),
      tabs,
      closedTabs: [],
      activeTabId: tabs[0]!.id,
      activeFilePath: null,
    });

  it("draws the icon of a tab's file before its title, pinned or not", async () => {
    seed([tab("a", "/vault/Notes/Idea.md", true), tab("b", "/vault/b.md")]);
    setFileIcons([{ path: "Notes/Idea.md", icon: "emoji:🚀" }]);
    await act(async () => root.render(createElement(EditorTabs)));
    const a = host.querySelector("[data-tab-id=a]")!;
    expect(a.querySelector("[data-icon-glyph]")?.textContent).toBe("🚀");
    expect(a.textContent).toContain("Idea");
    expect(host.querySelector("[data-tab-id=b] [data-icon-glyph]")).toBeNull();
  });

  it("follows a change of the icons", async () => {
    seed([tab("a", "/vault/Notes/Idea.md")]);
    await act(async () => root.render(createElement(EditorTabs)));
    expect(host.querySelector("[data-icon-glyph]")).toBeNull();
    await act(async () => setFileIcons([{ path: "Notes/Idea.md", icon: "emoji:📚" }]));
    expect(host.querySelector("[data-tab-id=a] [data-icon-glyph]")?.textContent).toBe("📚");
  });
});

describe("links", () => {
  it("a property wikilink shows the icon of the note it points to", async () => {
    setFileIcons([{ path: "Notes/Idea.md", icon: "emoji:🚀" }]);
    await act(async () => root.render(<WikiLinkButton value="[[Idea|my idea]]" />));
    await settle();
    const link = host.querySelector("[data-wikilink]")!;
    expect(link.querySelector("[data-icon-glyph]")?.textContent).toBe("🚀");
    expect(link.textContent).toBe("🚀my idea");
    expect(resolveWikiLinkTarget).toHaveBeenCalledWith("Idea", null);
  });

  it("a property wikilink without icons looks as before and asks the resolver nothing for the icon", async () => {
    await act(async () => root.render(<WikiLinkButton value="[[Idea]]" />));
    await settle();
    expect(host.querySelector("[data-icon-glyph]")).toBeNull();
    expect(host.querySelector("[data-wikilink]")!.textContent).toBe("Idea");
  });

  it("a rendered wikilink in the editor gets the icon inside the link, text kept in the file", async () => {
    setFileIcons([{ path: "Notes/Idea.md", icon: "emoji:🚀" }]);
    const doc = "see [[Idea]] now\n\nend";
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc,
        selection: { anchor: doc.length },
        extensions: [
          markdown(),
          wikiLinkExtension(
            () => "/vault/A.md",
            () => false,
          ),
        ],
      }),
    });
    await vi.waitFor(() => {
      const icon = view.dom.querySelector<HTMLElement>(".cm-wiki-link .cm-link-icon");
      expect(icon?.textContent).toBe("🚀");
    });
    expect(resolveWikiLinkTarget).toHaveBeenCalledWith("Idea", "/vault/A.md");
    expect(view.dom.querySelector(".cm-wiki-link")!.textContent).toBe("🚀Idea");
    expect(view.state.doc.toString()).toBe(doc);
    // the icon disappears with the icons (the feature off)
    act(() => clearFileIcons());
    await vi.waitFor(() =>
      expect(view.dom.querySelector<HTMLElement>(".cm-link-icon")!.style.display).toBe("none"),
    );
    view.destroy();
  });

  it("a Bases link cell and the file cell show the icon of their file", async () => {
    setFileIcons([
      { path: "Notes/Idea.md", icon: "emoji:🚀" },
      { path: "Rows/r.md", icon: "emoji:📚" },
    ]);
    const actions = { openLink: vi.fn(), openFile: vi.fn() } as never;
    const link = {
      type: "link",
      value: { target: "Idea", display: null, resolved: "Notes/Idea.md" },
      display: "Idea",
    } as never;
    await act(async () =>
      root.render(
        <>
          <CellView
            cell={link}
            columnKey="note.up"
            rowPath="Rows/r.md"
            readOnlyReason={null}
            actions={actions}
            onToggle={() => {}}
          />
          <CellView
            cell={{ type: "string", value: "r", display: "r" } as never}
            columnKey="file.name"
            rowPath="Rows/r.md"
            readOnlyReason={null}
            actions={actions}
            onToggle={() => {}}
          />
        </>,
      ),
    );
    expect([...host.querySelectorAll("[data-cell-link]")].map((l) => l.textContent)).toEqual([
      "🚀Idea",
      "📚r",
    ]);
  });

  it("a wikilink in the agent's rendered markdown gets the icon, including one that appears later", async () => {
    setFileIcons([{ path: "Notes/Idea.md", icon: "emoji:🚀" }]);
    function Pane() {
      const ref = useRef<HTMLDivElement>(null);
      useMarkdownLinks(ref);
      return <div ref={ref} data-pane />;
    }
    await act(async () => root.render(<Pane />));
    const pane = host.querySelector<HTMLElement>("[data-pane]")!;
    pane.innerHTML = '<p><a href="#wikilink:Idea">Idea</a></p>';
    await vi.waitFor(() => expect(pane.querySelector(".cm-link-icon")?.textContent).toBe("🚀"));
    expect(pane.querySelector("a")!.textContent).toBe("🚀Idea");
    pane.insertAdjacentHTML("beforeend", '<p><a href="#wikilink:Idea">Again</a></p>');
    await vi.waitFor(() => expect(pane.querySelectorAll(".cm-link-icon")).toHaveLength(2));
  });
});

describe("the tab menu", () => {
  it("is the core items, then what a feature contributes for the tab's file", async () => {
    const popped: unknown[][] = [];
    menuItemNew.mockImplementation(async (o: unknown) => o);
    menuNew.mockImplementation(async (o: { items: unknown[] }) => {
      popped.push(o.items);
      return { popup: async () => {} };
    });
    const features = createFeatureHost({ onError: () => {} });
    features.register(
      defineFeature({
        id: "tabby",
        contributes: {
          menus: {
            "editor-tab": [
              {
                id: "tabby.item",
                items: (path) => [
                  { kind: "item", id: "tabby", text: `Tab ${path}`, action: () => {} },
                ],
              },
            ],
          },
        },
      }),
    );
    await showTabContextMenu(
      [{ kind: "item", id: "close", text: "Close", action: () => {} }],
      "/vault/a.md",
    );
    expect(popped[0]!.map((i) => (i as { text?: string } | undefined)?.text)).toContain(
      "Tab /vault/a.md",
    );
    popped.length = 0;
    await showTabContextMenu(
      [{ kind: "item", id: "close", text: "Close", action: () => {} }],
      null,
    );
    expect(popped[0]!.map((i) => (i as { text?: string } | undefined)?.text)).toEqual(["Close"]);
    await features.unregister("tabby");
    expect(menuContributions.list().some((m) => m.owner === "builtin:tabby")).toBe(false);
  });
});

describe("one hook", () => {
  it("nothing but lib/file-icons.ts reads or writes the icon store", () => {
    const files = [...sourceFiles(join(DESKTOP, "src")), ...sourceFiles(join(DESKTOP, "features"))]
      .map((f) => relative(DESKTOP, f))
      .filter((f) => !f.includes("/tests/"));
    const touching = files.filter((f) =>
      /useFileIconStore/.test(readFileSync(join(DESKTOP, f), "utf8")),
    );
    expect(touching).toEqual(["src/lib/file-icons.ts"]);
  });

  it("only the Icons feature fills the store", () => {
    const files = [...sourceFiles(join(DESKTOP, "src")), ...sourceFiles(join(DESKTOP, "features"))]
      .map((f) => relative(DESKTOP, f))
      .filter((f) => !f.includes("/tests/"));
    const writers = files.filter((f) =>
      /\bsetFileIcons\(|\bclearFileIcons\(/.test(readFileSync(join(DESKTOP, f), "utf8")),
    );
    expect(writers.sort((a, b) => a.localeCompare(b))).toEqual([
      "features/icons/web/sync.ts",
      "src/lib/file-icons.ts",
    ]);
  });
});
