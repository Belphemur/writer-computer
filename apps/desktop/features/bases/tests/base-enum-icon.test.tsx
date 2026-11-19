// @vitest-environment jsdom
// An enum value's icon in Bases: before the text of a table cell (cards and list items render the
// same CellView) and before a group header's label, drawn by the one core `EnumValueIcon`; a
// value without an icon, another column and a non-enum property look as before.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { usePropertyTypesStore } from "@/stores/property-types-store";
import { CellView } from "../web/view/cell-view";
import { GroupHeader } from "../web/view/group-header";
import type { Cell } from "../web/lib/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const actions = { openLink: vi.fn(), openFile: vi.fn() } as never;
const str = (value: string) => ({ type: "string", value, display: value }) as Cell;
let host: HTMLDivElement;
let root: Root;

const cell = (c: Cell, columnKey: string) =>
  act(async () => {
    root.render(
      <CellView
        cell={c}
        columnKey={columnKey}
        rowPath="a.md"
        readOnlyReason={null}
        actions={actions}
        onToggle={() => {}}
      />,
    );
  });
const glyphs = () => [...host.querySelectorAll<HTMLElement>("[data-icon-glyph]")];

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  usePropertyTypesStore.setState({
    byKey: {
      status: {
        key: "status",
        type: "enum",
        source: "writer",
        values: ["todo", "done"],
        icons: { done: "emoji:✅" },
      } as never,
      plain: { key: "plain", type: "text", source: "writer", values: [], icons: {} } as never,
    },
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("enum value icons in Bases", () => {
  it("a table cell shows the icon before its text", async () => {
    await cell(str("done"), "status");
    expect(glyphs().map((g) => g.textContent)).toEqual(["✅"]);
    expect(host.textContent).toBe("✅done");
  });

  it("a value without an icon, another column and a non-enum property look as before", async () => {
    await cell(str("todo"), "status");
    expect(glyphs()).toHaveLength(0);
    await cell(str("done"), "other");
    expect(glyphs()).toHaveLength(0);
    await cell(str("done"), "plain");
    expect(glyphs()).toHaveLength(0);
    await cell(str("done"), "file.name");
    expect(glyphs()).toHaveLength(0);
    expect(host.textContent).toBe("done");
  });

  it("a group header (cards, list) shows the icon of the grouped enum value", async () => {
    const item = { kind: "group", key: "done", label: "done", count: 3, collapsed: false } as const;
    await act(async () => {
      root.render(<GroupHeader item={item} groupProperty="note.status" onToggle={() => {}} />);
    });
    expect(glyphs().map((g) => g.textContent)).toEqual(["✅"]);
    await act(async () => {
      root.render(<GroupHeader item={item} groupProperty="plain" onToggle={() => {}} />);
    });
    expect(glyphs()).toHaveLength(0);
    await act(async () => {
      root.render(<GroupHeader item={item} onToggle={() => {}} />);
    });
    expect(glyphs()).toHaveLength(0);
  });
});
