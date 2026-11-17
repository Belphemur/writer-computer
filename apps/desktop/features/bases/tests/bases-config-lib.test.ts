import { afterEach, describe, expect, it } from "vite-plus/test";
import { resultToCsv, resultToMarkdown } from "../web/lib/export";
import {
  compileRow,
  filterOf,
  literal,
  modelOf,
  parseRow,
  propertyExpression,
  validationBase,
  type FilterRow,
} from "../web/lib/filter-builder";
import {
  cardHeight,
  cardImage,
  cardItems,
  cardOptions,
  cardsPerRow,
  listItems,
  listOptions,
  markerText,
  safeVaultPath,
  sectionsOf,
} from "../web/lib/collections";
import { propertyChoices } from "../web/lib/property-choices";
import { cycleSort } from "../web/lib/sort";
import {
  getBaseView,
  listBaseViews,
  registerBaseView,
  subscribeBaseViews,
  unregisterBaseViewsOwnedBy,
  extraPropertiesOf,
} from "../web/lib/view-registry";
import { optionValueOrDefault, propertyOptionValues } from "../web/lib/view-options";
import { baseView, groupedResult, link, str, taskResult } from "./helpers/bases-fixtures";

describe("cycleSort", () => {
  it("cycles asc, desc, none on one column", () => {
    let keys = cycleSort([], "due", false);
    expect(keys).toEqual([{ property: "due", direction: "ASC" }]);
    keys = cycleSort(keys, "due", false);
    expect(keys).toEqual([{ property: "due", direction: "DESC" }]);
    expect(cycleSort(keys, "due", false)).toEqual([]);
  });
  it("an unsorted column replaces the sort, or is appended with shift", () => {
    const start = [{ property: "due", direction: "DESC" as const }];
    expect(cycleSort(start, "status", false)).toEqual([{ property: "status", direction: "ASC" }]);
    expect(cycleSort(start, "status", true)).toEqual([
      { property: "due", direction: "DESC" },
      { property: "status", direction: "ASC" },
    ]);
  });
  it("matches `note.x` and `x` as one property and keeps the position", () => {
    const keys = [
      { property: "a", direction: "ASC" as const },
      { property: "note.b", direction: "ASC" as const },
    ];
    expect(cycleSort(keys, "b", false)).toEqual([
      { property: "a", direction: "ASC" },
      { property: "note.b", direction: "DESC" },
    ]);
  });
});

describe("filter builder", () => {
  const rows: [FilterRow, string][] = [
    [{ property: "status", operator: "is", value: "open" }, 'status == "open"'],
    [{ property: "status", operator: "isNot", value: "done" }, 'status != "done"'],
    [{ property: "priority", operator: "is", value: "3" }, "priority == 3"],
    [{ property: "done", operator: "is", value: "true" }, "done == true"],
    [{ property: "tags", operator: "contains", value: "x" }, 'tags.contains("x")'],
    [{ property: "tags", operator: "notContains", value: "x" }, '!tags.contains("x")'],
    [{ property: "file.name", operator: "startsWith", value: "A" }, 'file.name.startsWith("A")'],
    [{ property: "file.name", operator: "endsWith", value: "z" }, 'file.name.endsWith("z")'],
    [{ property: "due", operator: "isEmpty", value: "" }, "due.isEmpty()"],
    [{ property: "due", operator: "isNotEmpty", value: "" }, "!due.isEmpty()"],
    [{ property: "due", operator: "lt", value: "2024-03-01" }, 'due < date("2024-03-01")'],
    [{ property: "score", operator: "gte", value: "8.5" }, "score >= 8.5"],
    [{ property: "formula.age", operator: "lte", value: "30" }, "formula.age <= 30"],
    [{ property: "creation date", operator: "is", value: "a" }, 'note["creation date"] == "a"'],
    [{ property: "status", operator: "is", value: 'say "hi"' }, 'status == "say \\"hi\\""'],
  ];
  it.each(rows)("compiles %j to %s and parses it back", (row, expression) => {
    expect(compileRow(row)).toBe(expression);
    expect(parseRow(expression)).toEqual(row);
  });
  it("normalizes note. ids and rejects expressions it did not write", () => {
    expect(compileRow({ property: "note.status", operator: "is", value: "x" })).toBe(
      'status == "x"',
    );
    for (const raw of [
      "status == 'open'",
      "len(tags) > 0",
      'status == "a" && x',
      'file.inFolder("Projects")',
      '!file.name.startsWith("A")',
      "",
    ])
      expect(parseRow(raw)).toBeNull();
  });
  it("property and literal helpers", () => {
    expect(propertyExpression("file.name")).toBe("file.name");
    expect(propertyExpression("formula.my f")).toBe('formula["my f"]');
    expect(propertyExpression("a-b")).toBe('note["a-b"]');
    expect(literal("is", "2024")).toBe("2024");
    expect(literal("contains", "2024")).toBe('"2024"');
    expect(literal("gt", "abc")).toBe('"abc"');
  });
  it("groups: one level and/or/not, kept nested groups, empty means no filter", () => {
    expect(modelOf(null)).toEqual({ mode: "and", items: [] });
    expect(modelOf("a")).toEqual({ mode: "and", items: ["a"] });
    const nested = { or: ["x", "y"] };
    const model = modelOf({ not: ["a", nested] });
    expect(model).toEqual({ mode: "not", items: ["a", nested] });
    expect(filterOf(model)).toEqual({ not: ["a", nested] });
    expect(filterOf({ mode: "or", items: [] })).toBeNull();
    expect(filterOf({ mode: "or", items: ["a"] })).toEqual({ or: ["a"] });
  });
  it("validationBase is a base whose only filter is the expression", () => {
    expect(validationBase('a == "x"')).toBe(
      'filters: "a == \\"x\\""\nviews:\n  - type: table\n    name: Check\n    limit: 1\n',
    );
  });
});

describe("export", () => {
  const result = taskResult();
  it("markdown table: display names, escaped pipes, shown columns only", () => {
    const withPipe = {
      ...result,
      rows: [
        {
          path: "a.md",
          cells: [str("a|b"), str("line1\nline2"), ...result.rows[0]!.cells.slice(2)],
        },
      ],
    };
    expect(resultToMarkdown(withPipe, 2)).toBe(
      "| Name | Status |\n| --- | --- |\n| a\\|b | line1 line2 |\n",
    );
  });
  it("csv: RFC 4180 quoting, header of display names, grouped order, hidden columns excluded", () => {
    const r = {
      ...result,
      rows: [
        { path: "a.md", cells: [str("a,b"), str('say "x"'), result.rows[0]!.cells[2]!] },
        { path: "b.md", cells: [str("plain"), str("two\nlines"), result.rows[1]!.cells[2]!] },
      ],
    };
    expect(resultToCsv(r, 2)).toBe('Name,Status\n"a,b","say ""x"""\nplain,"two\nlines"\n');
    expect(resultToCsv(result).split("\n")[0]).toBe("Name,Status,Done,Tags,Due,Age");
  });
});

describe("cards and list semantics", () => {
  it("cardOptions: defaults, documented keys, clamping", () => {
    expect(cardOptions(undefined)).toEqual({
      size: 200,
      image: null,
      fit: "cover",
      aspectRatio: 1,
    });
    expect(
      cardOptions(
        baseView({
          extra: { cardSize: 5000, image: "cover", imageFit: "contain", imageAspectRatio: 0.5 },
        }),
      ),
    ).toEqual({ size: 600, image: "cover", fit: "contain", aspectRatio: 0.5 });
    expect(
      cardOptions(baseView({ extra: { imageFit: "weird", imageAspectRatio: 99 } })).aspectRatio,
    ).toBe(3);
  });
  it("layout metrics are exact", () => {
    expect(cardsPerRow(900, 200)).toBe(4); // (900 - 24 + 12) / 212
    expect(cardsPerRow(10, 200)).toBe(1);
    const o = { size: 200, image: "cover", fit: "cover" as const, aspectRatio: 0.5 };
    expect(cardHeight(o, 3)).toBe(100 + 16 + 24 + 40);
    expect(cardHeight({ ...o, image: null }, 1)).toBe(40);
  });
  it("cardImage: colors, https, blocked schemes, vault files, lists", () => {
    expect(cardImage(str("#ff8800"))).toEqual({ kind: "color", color: "#ff8800" });
    expect(cardImage(str("https://example.com/a.png"))).toEqual({
      kind: "url",
      url: "https://example.com/a.png",
    });
    for (const bad of [
      "http://x/a.png",
      "data:image/png;base64,AAAA",
      "javascript:alert(1)",
      "file:///etc/passwd",
    ])
      expect(cardImage(str(bad)).kind).toBe("blocked");
    expect(cardImage(str("../secret.png")).kind).toBe("blocked");
    expect(cardImage(str(".obsidian/x.png")).kind).toBe("blocked");
    expect(cardImage(str("Attachments/pic.png"))).toEqual({
      kind: "file",
      path: "Attachments/pic.png",
    });
    expect(cardImage(str("![[pic.png]]"))).toEqual({ kind: "file", path: "pic.png" });
    expect(cardImage(link("pic.png", "Attachments/pic.png"))).toEqual({
      kind: "file",
      path: "Attachments/pic.png",
    });
    expect(cardImage(link("nope.png", null)).kind).toBe("blocked");
    expect(cardImage({ type: "null" })).toEqual({ kind: "none" });
    expect(cardImage(str("  "))).toEqual({ kind: "none" });
    expect(
      cardImage({ type: "list", value: [{ type: "null" }, { type: "string", value: "#fff" }] }),
    ).toEqual({
      kind: "color",
      color: "#fff",
    });
    expect(safeVaultPath("/a/b.png")).toBe("a/b.png");
    expect(safeVaultPath("a//b.png")).toBeNull();
  });
  it("listOptions and markers", () => {
    expect(listOptions(undefined)).toEqual({ markers: "bullets", indent: false, separator: ", " });
    expect(
      listOptions(
        baseView({ extra: { markers: "numbers", indentProperties: true, separator: " | " } }),
      ),
    ).toEqual({ markers: "numbers", indent: true, separator: " | " });
    expect(markerText("bullets", 1)).toBe("•");
    expect(markerText("numbers", 3)).toBe("3.");
    expect(markerText("none", 3)).toBe("");
  });
  it("sections, card rows and list items per group; ordinals restart in each group", () => {
    const grouped = groupedResult();
    const sections = sectionsOf(grouped);
    expect(sections.map((s) => [s.label, s.start, s.len])).toEqual([
      ["open", 0, 2],
      ["done", 2, 1],
    ]);
    const rows = cardItems(sections, 1, new Set());
    expect(rows.map((i) => (i.kind === "group" ? `g${i.count}` : `c${i.rows.join("+")}`))).toEqual([
      "g2",
      "c0",
      "c1",
      "g1",
      "c2",
    ]);
    const collapsed = new Set([sections[0]!.key!]);
    expect(cardItems(sections, 2, collapsed).map((i) => i.kind)).toEqual([
      "group",
      "group",
      "cards",
    ]);
    const items = listItems(sections, new Set(), () => 1);
    expect(
      items.filter((i) => i.kind === "row").map((i) => (i as { ordinal: number }).ordinal),
    ).toEqual([1, 2, 1]);
    expect(() =>
      sectionsOf({ rows: grouped.rows, groups: [{ ...grouped.groups![0]!, start: 1 }] }),
    ).toThrow(/Invalid group range/);
  });
});

describe("property choices and options", () => {
  it("file fields, formulas, then vault properties without duplicates", () => {
    const choices = propertyChoices(
      [
        { key: "status", count: 2, types: {} },
        { key: "file.name", count: 1, types: {} },
      ],
      { formulas: { age: "1" }, properties: { status: { displayName: "State" } } },
    );
    expect(choices.map((c) => c.id).slice(-3)).toEqual(["file.links", "formula.age", "status"]);
    expect(choices.find((c) => c.id === "status")!.label).toBe("State");
    expect(choices.filter((c) => c.id === "file.name")).toHaveLength(1);
  });
  it("optionValueOrDefault and property options", () => {
    const view = baseView({ extra: { image: "cover" } });
    const options = [
      { type: "property" as const, key: "image", displayName: "Image" },
      { type: "toggle" as const, key: "t", displayName: "T", default: true },
    ];
    expect(propertyOptionValues(view, options)).toEqual(["cover"]);
    expect(optionValueOrDefault(view, options[1]!)).toBe(true);
  });
});

describe("view registry", () => {
  const removers: (() => void)[] = [];
  afterEach(() => {
    for (const r of removers.splice(0)) r();
  });
  const Stub = () => null;

  it("built-in and plugin registrations share one function; first registration wins", () => {
    const remove = registerBaseView({
      type: "t-one",
      name: "One",
      icon: "x",
      owner: "p1",
      Component: Stub,
    });
    expect(remove).not.toBeNull();
    removers.push(remove!);
    expect(
      registerBaseView({ type: "t-one", name: "Two", icon: "x", owner: "p2", Component: Stub }),
    ).toBeNull();
    expect(getBaseView("t-one")!.name).toBe("One");
    expect(listBaseViews().some((e) => e.type === "t-one")).toBe(true);
  });
  it("needs exactly one of Component and mount, and an id", () => {
    expect(() => registerBaseView({ type: "bad", name: "B", icon: "x", owner: "p" })).toThrow(
      /exactly one/,
    );
    expect(() =>
      registerBaseView({ type: "", name: "B", icon: "x", owner: "p", Component: Stub }),
    ).toThrow(/non-empty/);
  });
  it("removal by owner notifies subscribers and leaves other owners alone", () => {
    let calls = 0;
    const off = subscribeBaseViews(() => calls++);
    registerBaseView({ type: "o-a", name: "A", icon: "x", owner: "own", Component: Stub });
    registerBaseView({ type: "o-b", name: "B", icon: "x", owner: "own", Component: Stub });
    registerBaseView({ type: "o-c", name: "C", icon: "x", owner: "other", Component: Stub });
    expect(unregisterBaseViewsOwnedBy("own")).toBe(2);
    expect(getBaseView("o-a")).toBeUndefined();
    expect(getBaseView("o-c")).toBeDefined();
    expect(unregisterBaseViewsOwnedBy("own")).toBe(0);
    expect(calls).toBe(4);
    unregisterBaseViewsOwnedBy("other");
    off();
  });
  it("the table, cards and list entries exist after the view module loads", async () => {
    await import("../web/view/builtin-views");
    for (const t of ["table", "cards", "list"]) expect(getBaseView(t)!.owner).toBe("core");
    expect(
      extraPropertiesOf(
        getBaseView("cards")!,
        baseView({ type: "cards", extra: { image: "cover" } }),
      ),
    ).toEqual(["cover"]);
    expect(extraPropertiesOf(getBaseView("list")!, baseView({ type: "list" }))).toEqual([]);
  });
});
