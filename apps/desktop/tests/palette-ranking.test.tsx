// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { invoke } from "@tauri-apps/api/core";
import { CommandPalette } from "../src/components/command-palette";
import { useUIStore } from "../src/stores/ui-store";
import { useWorkspaceStore } from "../src/stores/workspace-store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockedInvoke = vi.mocked(invoke);

function result(rel: string, indices: number[] = [], kind?: string) {
  return {
    path: `/ws/${rel}`,
    filename: rel.split("/").pop(),
    relative_path: rel,
    score: 1,
    match_indices: indices,
    ...(kind ? { kind } : {}),
  };
}

describe("file palette ranking", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    mockedInvoke.mockReset();
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    Element.prototype.scrollIntoView = () => {};
    Element.prototype.scrollTo = () => {};
    useWorkspaceStore.setState({ root: "/ws" });
    useUIStore.setState({
      isCommandPaletteOpen: true,
      commandPaletteIntent: "search",
      commandPaletteSearch: "",
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  async function settle() {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
  }

  function rows(): string[] {
    return [...document.querySelectorAll("[cmdk-item]")].map((el) =>
      el.getAttribute("data-value")!,
    );
  }

  it("lists recent files first on an empty query, then commands, in backend order", async () => {
    mockedInvoke.mockImplementation(((cmd: string, args: { query?: string }) => {
      if (cmd === "fuzzy_search") {
        expect(args.query).toBe("");
        return Promise.resolve([result("b/Opened Today.md"), result("a/Edited Yesterday.md")]);
      }
      return Promise.resolve([]);
    }) as never);
    await act(async () => {
      root.render(<CommandPalette />);
    });
    await settle();
    const values = rows();
    expect(values.slice(0, 2)).toEqual(["/ws/b/Opened Today.md", "/ws/a/Edited Yesterday.md"]);
    expect(values.length).toBeGreaterThan(2); // commands follow
    expect(document.body.textContent).toContain("Recent");
    expect(document.body.textContent).toContain("Suggested");
  });

  it("keeps the backend's ranking for a typed (typo) query", async () => {
    useUIStore.setState({ commandPaletteSearch: "francios lamare" });
    mockedInvoke.mockImplementation(((cmd: string) => {
      if (cmd === "fuzzy_search") {
        return Promise.resolve([
          result("People/François Lamarre.md", [7, 8]),
          result("People/Francine Lamb.md"),
        ]);
      }
      return Promise.resolve([]);
    }) as never);
    await act(async () => {
      root.render(<CommandPalette />);
    });
    await settle();
    const files = rows().filter((v) => v.startsWith("/ws/"));
    expect(files).toEqual(["/ws/People/François Lamarre.md", "/ws/People/Francine Lamb.md"]);
    expect(mockedInvoke).toHaveBeenCalledWith("fuzzy_search", {
      query: "francios lamare",
      limit: 20,
    });
  });

  it("filters quick open by kind from the registry's chips and draws each row's kind icon", async () => {
    useUIStore.setState({ commandPaletteSearch: "report" });
    const KINDS = [
      { id: "note", label: "Notes", icon: "File02Icon" },
      { id: "pdf", label: "PDFs", icon: "Pdf02Icon" },
    ];
    mockedInvoke.mockImplementation(((cmd: string, args: { kinds?: string[] }) => {
      if (cmd === "search_kinds") return Promise.resolve(KINDS);
      if (cmd === "fuzzy_search") {
        return Promise.resolve(
          args.kinds?.includes("pdf")
            ? [result("Papers/Report.pdf", [], "pdf")]
            : [result("Notes/Report.md", [], "note"), result("Papers/Report.pdf", [], "pdf")],
        );
      }
      return Promise.resolve([]);
    }) as never);
    await act(async () => {
      root.render(<CommandPalette />);
    });
    await settle();
    const chips = [...document.querySelectorAll<HTMLElement>("[data-testid^='kind-chip-']")];
    expect(chips.map((c) => c.textContent)).toEqual(["All", "Notes", "PDFs"]);
    expect(
      [...document.querySelectorAll<HTMLElement>("[data-kind-icon]")].map(
        (i) => i.dataset.kindIcon,
      ),
    ).toEqual(["note", "pdf"]);
    await act(async () => {
      document.querySelector<HTMLElement>("[data-testid='kind-chip-pdf']")!.click();
    });
    await settle();
    expect(mockedInvoke).toHaveBeenLastCalledWith("fuzzy_search", {
      query: "report",
      limit: 20,
      kinds: ["pdf"],
    });
    expect(rows().filter((v) => v.startsWith("/ws/"))).toEqual(["/ws/Papers/Report.pdf"]);
  });
});
