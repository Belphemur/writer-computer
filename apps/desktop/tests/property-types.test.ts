// The frontend property-type source: registry (an icon, label and warning per type, incl. the
// unknown/mixed state), row/type fit rules, the store (load, optimistic set, rollback) and the
// plugin host's `metadataTypeManager` shim reading and writing that one source.
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

const ipc = vi.hoisted(() => ({
  propertyTypes: vi.fn(),
  propertyTypeSet: vi.fn(),
}));
vi.mock("../src/lib/property-types-ipc", () => ipc);
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { parseProperties, type PropertyRow } from "../src/lib/frontmatter-properties";
import {
  menuTypes,
  MISMATCH_ICON,
  PROPERTY_TYPE_IDS,
  PROPERTY_TYPES,
  rowFitsType,
  typeOfRow,
} from "../src/lib/property-types";
import { MetadataTypeManager } from "../features/obsidian-host/web/host/api/app";
import { usePropertyTypesStore } from "../src/stores/property-types-store";

function rows(fm: string): Record<string, PropertyRow> {
  const p = parseProperties(fm);
  if (!p.ok) throw new Error(p.message);
  return Object.fromEntries(p.rows.map((r) => [r.key, r]));
}

const INFO = (key: string, type: string, source = "writer") => ({
  key,
  count: 2,
  types: {},
  type,
  source,
  mismatched: 0,
  obsidianType:
    type === "relationships" ? "multitext" : type === "enum" || type === "object" ? "text" : type,
  values: [] as string[],
});

beforeEach(() => {
  usePropertyTypesStore.setState({ byKey: {}, loadedAt: 0 });
  ipc.propertyTypes
    .mockReset()
    .mockResolvedValue([INFO("Due", "date"), INFO("n", "number", "obsidian")]);
  ipc.propertyTypeSet.mockReset().mockResolvedValue(undefined);
});

describe("registry", () => {
  test("every type has its own icon, a label and a warning; the mixed state has another icon", () => {
    const icons = new Set(PROPERTY_TYPE_IDS.map((t) => PROPERTY_TYPES[t].icon));
    expect(icons.size).toBe(PROPERTY_TYPE_IDS.length);
    expect(icons.has(MISMATCH_ICON)).toBe(false);
    for (const t of PROPERTY_TYPE_IDS) {
      expect(PROPERTY_TYPES[t].label).not.toBe("");
      expect(PROPERTY_TYPES[t].warning).not.toBe("");
    }
  });
  test("relationships has its own link icon and sits after List in the menu", () => {
    expect(PROPERTY_TYPES.relationships.label).toBe("Relationships");
    expect(PROPERTY_TYPES.relationships.warning).toBe("Not a link");
    expect(menuTypes("text")).toContain("relationships");
    const order = menuTypes("text");
    expect(order.indexOf("relationships")).toBe(order.indexOf("multitext") + 1);
  });
  test("the menu lists the pickable types, plus a special current one", () => {
    expect(menuTypes("text").map((t) => PROPERTY_TYPES[t].label)).toEqual([
      "Text",
      "List",
      "Relationships",
      "URL",
      "Enum",
      "Object",
      "Number",
      "Checkbox",
      "Date",
      "Date & time",
    ]);
    expect(menuTypes("tags")).toContain("tags");
    expect(menuTypes("aliases")).toContain("aliases");
  });
});

describe("rows and types", () => {
  const r = rows(
    "t: x\nn: 1\nc: true\nd: 2026-01-01\ndt: 2026-01-01T10:00\nl: [a]\ntags: [a]\naliases: [a]\nk: '[[A]]'\ne:\nm:\n  a: 1\nlinks: ['[[A]]', '[[B|b]]']\nmix: ['[[A]]', x]\nnone: []",
  );
  test("a row's own type", () => {
    expect(
      Object.fromEntries(Object.entries(r).map(([k, row]) => [k, typeOfRow(row)])),
    ).toMatchObject({
      t: "text",
      n: "number",
      c: "checkbox",
      d: "date",
      dt: "datetime",
      l: "multitext",
      tags: "tags",
      k: "relationships",
      links: "relationships",
      mix: "multitext",
      none: "multitext",
      m: "object",
    });
  });
  test("object fits a map (editable or read-only) and an empty value only", () => {
    const o = rows("a:\n  x: 1\nb: {x: 1}\nc: {}\nd:\ne: x\nf: [x]");
    for (const k of ["a", "b", "c", "d"]) expect(rowFitsType(o[k], "object")).toBe(true);
    for (const k of ["e", "f"]) expect(rowFitsType(o[k], "object")).toBe(false);
    expect(rowFitsType(o.a, "text")).toBe(false);
    expect(PROPERTY_TYPES.object).toMatchObject({
      label: "Object",
      warning: "Not an object",
      writerOnly: true,
    });
  });
  test("relationships fits a link, a list of links and an empty value only", () => {
    expect(rowFitsType(r.k, "relationships")).toBe(true);
    expect(rowFitsType(r.links, "relationships")).toBe(true);
    expect(rowFitsType(r.none, "relationships")).toBe(true);
    expect(rowFitsType(r.e, "relationships")).toBe(true);
    expect(rowFitsType(r.mix, "relationships")).toBe(false);
    expect(rowFitsType(r.t, "relationships")).toBe(false);
    expect(rowFitsType(r.l, "relationships")).toBe(false);
    // a list of links is still a valid List, a single link a valid Text
    expect(rowFitsType(r.links, "multitext")).toBe(true);
    expect(rowFitsType(r.k, "text")).toBe(true);
  });
  test("values that do not fit their declared type are flagged; empty fits everything", () => {
    expect(rowFitsType(r.t, "number")).toBe(false);
    expect(rowFitsType(r.n, "text")).toBe(false);
    expect(rowFitsType(r.k, "text")).toBe(true);
    expect(rowFitsType(r.l, "tags")).toBe(true);
    expect(rowFitsType(r.e, "checkbox")).toBe(true);
    expect(rowFitsType(r.m, "text")).toBe(false);
  });
});

describe("store", () => {
  test("loads once while fresh, keyed by lower-cased name", async () => {
    await usePropertyTypesStore.getState().load();
    await usePropertyTypesStore.getState().load();
    expect(ipc.propertyTypes).toHaveBeenCalledTimes(1);
    expect(usePropertyTypesStore.getState().byKey.due.type).toBe("date");
  });
  test("setType('object') guesses the plugin-facing type as text until the refetch", async () => {
    await usePropertyTypesStore.getState().load();
    await usePropertyTypesStore.getState().setType("Meta", "object");
    expect(usePropertyTypesStore.getState().byKey.meta).toMatchObject({
      type: "object",
      obsidianType: "text",
    });
    expect(ipc.propertyTypeSet).toHaveBeenLastCalledWith("Meta", "object");
  });
  test("setType('url') records it and keeps the plugin-facing shape until the refetch", async () => {
    ipc.propertyTypes.mockResolvedValue([
      { ...INFO("sources", "text"), obsidianType: "multitext" },
    ]);
    await usePropertyTypesStore.getState().load();
    await usePropertyTypesStore.getState().setType("sources", "url");
    expect(usePropertyTypesStore.getState().byKey.sources).toMatchObject({
      type: "url",
      source: "writer",
      obsidianType: "multitext",
    });
    expect(ipc.propertyTypeSet).toHaveBeenLastCalledWith("sources", "url");
  });
  test("setType records through the backend and updates at once", async () => {
    await usePropertyTypesStore.getState().load();
    const done = usePropertyTypesStore.getState().setType("Status", "checkbox");
    expect(usePropertyTypesStore.getState().byKey.status).toMatchObject({
      type: "checkbox",
      source: "writer",
    });
    await done;
    expect(ipc.propertyTypeSet).toHaveBeenCalledWith("Status", "checkbox");
  });
  test("an enum without values is seeded by the backend; addEnumValue appends once, trimmed", async () => {
    ipc.propertyTypes.mockResolvedValue([INFO("status", "enum", "writer")]);
    await usePropertyTypesStore.getState().load();
    await usePropertyTypesStore.getState().setType("status", "enum");
    expect(ipc.propertyTypeSet).toHaveBeenLastCalledWith("status", "enum");
    ipc.propertyTypeSet.mockClear();
    ipc.propertyTypes.mockResolvedValue([{ ...INFO("status", "enum"), values: ["a"] }]);
    await usePropertyTypesStore.getState().load(true);
    expect(await usePropertyTypesStore.getState().addEnumValue("Status", " b ")).toBe("b");
    expect(ipc.propertyTypeSet).toHaveBeenCalledWith("Status", "enum", ["a", "b"]);
    expect(usePropertyTypesStore.getState().byKey.status.values).toEqual(["a", "b"]);
    ipc.propertyTypeSet.mockClear();
    await usePropertyTypesStore.getState().addEnumValue("status", "a"); // already there
    expect(ipc.propertyTypeSet).not.toHaveBeenCalled();
  });
  test("a failed write rolls the local record back", async () => {
    await usePropertyTypesStore.getState().load();
    ipc.propertyTypeSet.mockRejectedValue(new Error("disk full"));
    await expect(usePropertyTypesStore.getState().setType("due", "text")).rejects.toThrow("disk");
    expect(usePropertyTypesStore.getState().byKey.due.type).toBe("date");
    await expect(usePropertyTypesStore.getState().setType("new", "text")).rejects.toThrow();
    expect(usePropertyTypesStore.getState().byKey.new).toBeUndefined();
  });
});

describe("plugin host metadataTypeManager", () => {
  test("reads the one source", async () => {
    const m = new MetadataTypeManager();
    await m.load();
    expect(m.getAllProperties()).toEqual({
      due: { name: "Due", type: "date", count: 2 },
      n: { name: "n", type: "number", count: 2 },
    });
    expect(m.getPropertyInfo("DUE")?.type).toBe("date");
    expect(m.getAssignedType("due")).toBe("date");
    expect(m.getAssignedType("nope")).toBeNull();
  });
  test("relationships is reported as multitext (text for single links) and cannot be set", async () => {
    ipc.propertyTypes.mockResolvedValue([
      { ...INFO("team", "relationships"), obsidianType: "multitext" },
      { ...INFO("manager", "relationships"), obsidianType: "text" },
    ]);
    const m = new MetadataTypeManager();
    await m.load();
    expect(m.getPropertyInfo("team")?.type).toBe("multitext");
    expect(m.getPropertyInfo("manager")?.type).toBe("text");
    expect(m.getAllProperties().team.type).toBe("multitext");
    expect(m.getAssignedType("team")).toBe("multitext");
    await expect(m.setType("team", "relationships")).rejects.toThrow("Unknown property type");
    expect(ipc.propertyTypeSet).not.toHaveBeenCalled();
  });
  test("enum is reported as text and cannot be set by a plugin", async () => {
    ipc.propertyTypes.mockResolvedValue([{ ...INFO("status", "enum"), values: ["a", "b"] }]);
    const m = new MetadataTypeManager();
    await m.load();
    expect(m.getPropertyInfo("status")?.type).toBe("text");
    expect(m.getAssignedType("status")).toBe("text");
    await expect(m.setType("status", "enum")).rejects.toThrow("Unknown property type");
    expect(ipc.propertyTypeSet).not.toHaveBeenCalled();
  });
  test("object is reported as text and cannot be set by a plugin", async () => {
    ipc.propertyTypes.mockResolvedValue([INFO("metadata", "object")]);
    const m = new MetadataTypeManager();
    await m.load();
    expect(m.getPropertyInfo("metadata")?.type).toBe("text");
    expect(m.getAssignedType("metadata")).toBe("text");
    await expect(m.setType("metadata", "object")).rejects.toThrow("Unknown property type");
    expect(ipc.propertyTypeSet).not.toHaveBeenCalled();
  });
  test("url is reported as text (multitext for lists) and cannot be set by a plugin", async () => {
    ipc.propertyTypes.mockResolvedValue([
      { ...INFO("website", "url"), obsidianType: "text" },
      { ...INFO("sources", "url"), obsidianType: "multitext" },
    ]);
    const m = new MetadataTypeManager();
    await m.load();
    expect(m.getPropertyInfo("website")?.type).toBe("text");
    expect(m.getAssignedType("website")).toBe("text");
    expect(m.getAllProperties().sources.type).toBe("multitext");
    await expect(m.setType("website", "url")).rejects.toThrow("Unknown property type");
    expect(ipc.propertyTypeSet).not.toHaveBeenCalled();
  });
  test("an inferred type is not an assigned one", async () => {
    ipc.propertyTypes.mockResolvedValue([INFO("x", "number", "inferred")]);
    const m = new MetadataTypeManager();
    await m.load();
    expect(m.getPropertyInfo("x")?.type).toBe("number");
    expect(m.getAssignedType("x")).toBeNull();
  });
  test("setType writes Writer's record (the backend command), and rejects unknown types", async () => {
    const m = new MetadataTypeManager();
    // The fake backend "persists" the record the way the real one does, for the refetch after a write.
    ipc.propertyTypes.mockResolvedValue([INFO("Mood", "multitext")]);
    await m.setType("Mood", "multitext");
    expect(ipc.propertyTypeSet).toHaveBeenCalledWith("Mood", "multitext");
    expect(m.getAssignedType("mood")).toBe("multitext");
    await expect(m.setType("Mood", "fancy")).rejects.toThrow("Unknown property type");
    expect(ipc.propertyTypeSet).toHaveBeenCalledTimes(1);
  });
});
