// @vitest-environment jsdom
// A `url` property's cells in a base are the core link chip (`@/components/url-chip`), the same
// component as the properties panel: a click opens through link activation, a value that is no URL
// is marked and never a link, any other column keeps its plain look.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(), openPath: vi.fn() }));

import { openUrl } from "@tauri-apps/plugin-opener";
import { usePropertyTypesStore } from "@/stores/property-types-store";
import { CellView } from "../web/view/cell-view";
import type { Cell } from "../web/lib/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const actions = { openLink: vi.fn(), openFile: vi.fn() } as never;
const str = (value: string) => ({ type: "string", value, display: value }) as Cell;
const list = (...v: string[]) =>
  ({
    type: "list",
    value: v.map((value) => ({ type: "string", value })),
    display: v.join(", "),
  }) as Cell;

let host: HTMLDivElement;
let root: Root;
async function show(cell: Cell, columnKey = "site") {
  await act(async () => {
    root.render(
      <CellView
        cell={cell}
        columnKey={columnKey}
        rowPath="a.md"
        readOnlyReason={null}
        actions={actions}
        onToggle={() => {}}
      />,
    );
  });
}
const chips = () => [...host.querySelectorAll<HTMLElement>("[data-url-chip]")];

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.mocked(openUrl).mockReset().mockResolvedValue(undefined);
  usePropertyTypesStore.setState({
    byKey: {
      site: { key: "site", type: "url", source: "writer" } as never,
      other: { key: "other", type: "text", source: "writer" } as never,
    },
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("url cells", () => {
  it("a url column shows each address as a link chip that opens on click", async () => {
    await show(list("https://www.example.com/a", "other.example"));
    expect(chips().map((c) => c.textContent)).toEqual(["example.com/a", "other.example"]);
    const link = chips()[1]!.querySelector("button")!;
    await act(async () => link.click());
    expect(openUrl).toHaveBeenCalledWith("https://other.example");
    await act(async () => {
      link.dispatchEvent(
        new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true }),
      );
    });
    expect(openUrl).toHaveBeenCalledTimes(2);
  });

  it("a single text is one chip; a value that is no URL is marked, not a link", async () => {
    await show(str("https://one.example"));
    expect(chips()).toHaveLength(1);
    await show(str("just words"));
    expect(chips()[0]!.dataset.invalid).toBe("true");
    expect(chips()[0]!.querySelector("button")).toBeNull();
    expect(chips()[0]!.textContent).toBe("just words");
  });

  it("another column, or a file property, keeps its plain cell", async () => {
    await show(str("https://one.example"), "other");
    expect(chips()).toHaveLength(0);
    expect(host.textContent).toBe("https://one.example");
    await show(str("x.example"), "file.name");
    expect(chips()).toHaveLength(0);
  });
});
