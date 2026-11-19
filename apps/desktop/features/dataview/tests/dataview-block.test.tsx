// @vitest-environment jsdom
// The Dataview block widget: a dataviewjs block is a placeholder that never reaches the backend, a
// bad query shows its position, a good one renders through the Bases embed, and Convert to Base
// writes the file and offers to replace the block.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));
vi.mock("../web/ipc", () => ({ dqlLower: vi.fn(), dqlConvert: vi.fn() }));

import { serviceContributions } from "@/lib/features/services";
import { createFeatureHost } from "@/lib/features/registry";
import { DataviewBlockView } from "../web/dataview-block";
import { blockKindOfInfo, errorContext } from "../web/blocks";
import * as ipc from "../web/ipc";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const lowered = (over: Record<string, unknown> = {}) => ({
  kind: "table",
  liveText: "views: []",
  convertible: true,
  unmapped: [],
  error: null,
  ...over,
});

let container: HTMLElement;
let root: Root;
const host = createFeatureHost({ onError: () => {} });
const seen: unknown[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  seen.length = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  host.register({
    id: "bases",
    contributes: {
      services: [
        {
          id: "bases.views",
          service: {
            loadEmbeddedBase: async () => (p: { embed: unknown }) => {
              seen.push(p.embed);
              return <div data-fake-base />;
            },
          },
        },
      ],
    },
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  await host.unregister("bases");
  vi.useRealTimers();
  expect(serviceContributions.list().filter((s) => s.owner === "builtin:bases")).toEqual([]);
});

const props = (block: { kind: "query" | "js"; source: string }, over = {}) => ({
  block,
  notePath: "/v/n.md",
  onEdit: vi.fn(),
  onReplace: vi.fn(),
  ...over,
});
const mount = async (p: ReturnType<typeof props>) => {
  await act(async () => root.render(<DataviewBlockView {...p} />));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
};

describe("fence info", () => {
  it("knows dataview and dataviewjs only", () => {
    expect(blockKindOfInfo("dataview")).toBe("query");
    expect(blockKindOfInfo(" DataviewJS ")).toBe("js");
    expect(blockKindOfInfo("dataview-x")).toBeNull();
    expect(errorContext("a\nbcd", 2, 3)).toBe("bcd\n  ^");
  });
});

describe("DataviewBlockView", () => {
  it("shows a placeholder for dataviewjs and never calls the backend", async () => {
    await mount(props({ kind: "js", source: "dv.table([])" }));
    expect(container.querySelector("[data-dataview-js]")?.textContent).toMatch(/not supported/);
    expect(ipc.dqlLower).not.toHaveBeenCalled();
  });

  it("shows line and column of a query error", async () => {
    vi.mocked(ipc.dqlLower).mockResolvedValue(
      lowered({ liveText: "", error: { message: "expected a value", line: 1, col: 7 } }) as never,
    );
    await mount(props({ kind: "query", source: "TABLE +" }));
    expect(container.querySelector("[data-dataview-error]")?.textContent).toBe(
      "Line 1, column 7: expected a value",
    );
  });

  it("renders a good query through the Bases embed with the lowered text", async () => {
    vi.mocked(ipc.dqlLower).mockResolvedValue(lowered() as never);
    await mount(props({ kind: "query", source: "TABLE file.name" }));
    expect(container.querySelector("[data-fake-base]")).not.toBeNull();
    expect(seen).toEqual([{ kind: "block", text: "views: []" }]);
  });

  it("disables Convert with the reason when a clause has no base form", async () => {
    vi.mocked(ipc.dqlLower).mockResolvedValue(
      lowered({
        convertible: false,
        unmapped: [{ clause: "FLATTEN", reason: "no base form", line: 1, col: 1 }],
      }) as never,
    );
    await mount(props({ kind: "query", source: "TABLE x FLATTEN y" }));
    const button = container.querySelector<HTMLButtonElement>("[data-dataview-convert]")!;
    expect(button.disabled).toBe(true);
    expect(button.title).toContain("FLATTEN");
  });

  it("converts, then replaces the block with an embed", async () => {
    vi.mocked(ipc.dqlLower).mockResolvedValue(lowered() as never);
    vi.mocked(ipc.dqlConvert).mockResolvedValue("Dataview query.base");
    const p = props({ kind: "query", source: "TABLE file.name" });
    await mount(p);
    await act(async () =>
      container.querySelector<HTMLButtonElement>("[data-dataview-convert]")!.click(),
    );
    expect(ipc.dqlConvert).toHaveBeenCalledWith("TABLE file.name", "/v/n.md");
    expect(container.querySelector("[data-dataview-converted]")?.textContent).toContain(
      "Dataview query.base",
    );
    await act(async () =>
      container.querySelector<HTMLButtonElement>("[data-dataview-replace]")!.click(),
    );
    expect(p.onReplace).toHaveBeenCalledWith("![[Dataview query.base]]");
  });
});

describe("plugin takeover", () => {
  it("asks once, through the shared prompt, when the Dataview plugin is running", async () => {
    const { setRunningCommunityPlugins, setCommunityPluginControl } =
      await import("@/lib/community-plugins");
    const tauri = await import("@/lib/tauri");
    const confirm = vi.spyOn(tauri, "confirmAction").mockResolvedValue(true);
    const setEnabled = vi.fn(async () => {});
    localStorage.clear();
    setRunningCommunityPlugins(["dataview"]);
    setCommunityPluginControl({ setEnabled });
    const { offerDataviewTakeover, ASKED_KEY } = await import("../web/takeover");
    expect(await offerDataviewTakeover()).toBe(true);
    expect(setEnabled).toHaveBeenCalledWith("dataview", false);
    expect(localStorage.getItem(ASKED_KEY)).toBe("1");
    expect(await offerDataviewTakeover()).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
    setRunningCommunityPlugins([]);
    setCommunityPluginControl(null);
  });
});
