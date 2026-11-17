import { describe, expect, it } from "vite-plus/test";
import { buildPrompt } from "@features/agent/web/lib/context-text";
import {
  frontmatterMeta,
  openTabsBlock,
  openTabsFrom,
  wikilinkTarget,
  type OpenTab,
  type TabLike,
} from "@features/agent/web/lib/open-tabs";

const tab = (id: string, location: TabLike["location"]): TabLike => ({ id, location });
const file = (id: string, path: string) => tab(id, { kind: "file", path });
const src = (tabs: TabLike[], activeTabId: string | null, fm: Record<string, string> = {}) => ({
  tabs,
  activeTabId,
  toSentPath: (p: string) => (p.startsWith("/out/") ? null : p),
  frontmatterOf: (p: string) => fm[p],
});
const n = (path: string, active = false): OpenTab => ({ path, active, kind: "note" });

describe("openTabsFrom", () => {
  it("keeps vault files in tab order, marks the active one, dedupes", () => {
    const tabs = [file("1", "b.md"), file("2", "a.md"), file("3", "b.md")];
    const out = openTabsFrom(src(tabs, "3"));
    expect(out.map((t) => [t.path, t.active])).toEqual([
      ["b.md", true],
      ["a.md", false],
    ]);
  });

  it("excludes launcher, settings, plugin pages and files outside the vault", () => {
    const tabs = [
      tab("1", { kind: "launcher" }),
      tab("2", { kind: "settings" }),
      tab("3", { kind: "plugin-view" }),
      tab("4", { kind: "plugin-file", path: "p.md" }),
      file("5", "/out/x.md"),
      file("6", "keep.md"),
      tab("7", { kind: "base", path: "T.base", view: "Open" }),
      tab("8", { kind: "code", path: "s.py" }),
      file("9", "Board.canvas"),
      file("10", "pic.png"),
    ];
    const out = openTabsFrom(src(tabs, null));
    expect(out.map((t) => [t.path, t.kind])).toEqual([
      ["keep.md", "note"],
      ["T.base", "base"],
      ["s.py", "code"],
      ["Board.canvas", "canvas"],
      ["pic.png", "other"],
    ]);
    expect(out[1]!.view).toBe("Open");
  });

  it("reads note metadata from the open document, never for code", () => {
    const fm = { "a.md": "tags: [x]\ntype: project" };
    const out = openTabsFrom(
      src([file("1", "a.md"), tab("2", { kind: "code", path: "c.ts" })], "1", fm),
    );
    expect(out[0]!.tags).toEqual(["x"]);
    expect(out[0]!.props).toEqual([{ key: "type", value: "project" }]);
    expect(out[1]!.tags).toBeUndefined();
  });
});

describe("frontmatterMeta", () => {
  it("collects tags, type-like props and relationship links, not other values", () => {
    const meta = frontmatterMeta(
      [
        "tags: [a, b]",
        "type: person",
        "status: active",
        'manager: "[[Ana Diaz|Ana]]"',
        'team: ["[[A]]", "[[B#Head]]"]',
        "title: Secret title",
        "notes: [one, two]",
      ].join("\n"),
    );
    expect(meta.tags).toEqual(["a", "b"]);
    expect(meta.props).toEqual([
      { key: "type", value: "person" },
      { key: "status", value: "active" },
    ]);
    expect(meta.links).toEqual([
      { key: "manager", targets: ["Ana Diaz"] },
      { key: "team", targets: ["A", "B"] },
    ]);
  });

  it("uses the vault's recorded type and ignores unparsable or empty frontmatter", () => {
    expect(
      frontmatterMeta("boss: '[[X]]'", (k) => (k === "boss" ? "text" : undefined)).links,
    ).toBeUndefined();
    expect(frontmatterMeta("boss: '[[X]]'", () => "relationships").links).toEqual([
      { key: "boss", targets: ["X"] },
    ]);
    expect(frontmatterMeta("a: [unclosed")).toEqual({});
    expect(frontmatterMeta(null)).toEqual({});
  });

  it("wikilinkTarget drops alias and heading", () => {
    expect(wikilinkTarget("[[A/B|c#d]]")).toBe("A/B");
    expect(wikilinkTarget("plain")).toBeNull();
  });
});

describe("openTabsBlock", () => {
  it("is null with no tabs", () => expect(openTabsBlock([])).toBeNull());

  it("quotes every path, including ones with spaces and quotes", () => {
    const b = openTabsBlock([n("My Notes/Plan.md", true), n('we"ird.md')])!;
    expect(b).toContain('- "My Notes/Plan.md" (active; note)');
    expect(b).toContain('- "we\\"ird.md" (note)');
  });

  it("caps at 20 tabs, summarises the rest and keeps the active tab", () => {
    const tabs = Array.from({ length: 25 }, (_, i) => n(`n${i}.md`, i === 23));
    const b = openTabsBlock(tabs)!;
    const lines = b.split("\n").filter((l) => l.startsWith("- "));
    expect(lines).toHaveLength(21);
    expect(lines[19]).toBe('- "n23.md" (active; note)');
    expect(lines[20]).toBe("- +5 more");
    expect(b).not.toContain("n24.md");
  });

  it("renders metadata with caps", () => {
    const b = openTabsBlock([
      {
        path: "a.md",
        active: false,
        kind: "note",
        tags: Array.from({ length: 10 }, (_, i) => `t${i}`),
        links: [{ key: "up", targets: ["1", "2", "3", "4", "5", "6", "7"] }],
      },
      { path: "T.base", active: false, kind: "base", view: "Open" },
    ])!;
    expect(b).toContain("tags: t0, t1, t2, t3, t4, t5, t6, t7, +2 more");
    expect(b).toContain("up: [[1]], [[2]], [[3]], [[4]], [[5]], +2 more");
    expect(b).toContain('- "T.base" (base; view "Open")');
  });

  it("cuts a long value to 80 characters", () => {
    const meta = frontmatterMeta(`type: ${"x".repeat(200)}`);
    expect(meta.props![0]!.value).toHaveLength(80);
  });
});

describe("buildPrompt with open tabs", () => {
  it("appends the block after references, none without tabs, none behind a command", () => {
    const ref = { kind: "note", path: "a.md" } as const;
    const withTabs = buildPrompt({
      text: "see @a.md",
      refs: [ref],
      cwd: null,
      openTabs: [n("a.md", true)],
    });
    expect(withTabs.indexOf("</references>")).toBeLessThan(withTabs.indexOf("<open-tabs>"));
    expect(buildPrompt({ text: "hi", refs: [], cwd: null, openTabs: [] })).toBe("hi");
    expect(buildPrompt({ text: "/x go", refs: [], cwd: null, openTabs: [n("a.md")] })).toBe(
      "/x go",
    );
  });
});
