// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("../src/components/editor-area/reveal-line", () => ({ openFileAtLine: vi.fn() }));
vi.mock("../src/lib/link-activation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/link-activation")>()),
  openPathAtAnchor: vi.fn(),
}));
// The kind list is the backend registry over IPC (`search_kinds`); these tests set it directly so
// the search requests they count stay the only `invoke` calls.
const listedKinds = vi.hoisted(() => ({
  current: [] as { id: string; label: string; icon: string }[],
}));
vi.mock("../src/components/command-palette/use-search-kinds", () => ({
  useSearchKinds: () => listedKinds.current,
}));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ContentSearchPalette } from "../src/components/command-palette/content-search-palette";
import { CONTENT_SEARCH_DEBOUNCE_MS } from "../src/components/command-palette/use-content-search";
import { openFileAtLine } from "../src/components/editor-area/reveal-line";
import { activateLink, openPathAtAnchor, tagLinkTarget } from "../src/lib/link-activation";
import {
  hitLocation,
  isIndexBuildingError,
  snippetPlace,
  splitByRanges,
  type ContentSearchHit,
  type ContentSearchPage,
} from "../src/lib/content-search";
import { useUIStore } from "../src/stores/ui-store";
import { useWorkspaceStore } from "../src/stores/workspace-store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockedInvoke = vi.mocked(invoke);
const mockedListen = vi.mocked(listen);
const mockedOpen = vi.mocked(openFileAtLine);
const mockedOpenAnchor = vi.mocked(openPathAtAnchor);

function hit(path: string, line: number, text: string, ranges: [number, number][]) {
  const base = path.split("/").pop()!.replace(/\.md$/, "");
  return {
    path,
    title: base,
    folder: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
    kind: "note",
    score: 1,
    snippets: [{ line, inFile: true, text, ranges }],
    stale: false,
  } satisfies ContentSearchHit;
}

function page(...hits: ContentSearchHit[]): ContentSearchPage {
  return { total: hits.length, hits, truncated: false };
}

describe("splitByRanges", () => {
  it("splits plain and matched text and never produces markup", () => {
    expect(splitByRanges("a <b>x</b> c", [[2, 5]])).toEqual([
      { text: "a ", match: false },
      { text: "<b>", match: true },
      { text: "x</b> c", match: false },
    ]);
  });

  it("clamps, sorts and merges bad ranges instead of throwing", () => {
    const parts = splitByRanges("abcdef", [
      [4, 99],
      [1, 3],
      [2, 5],
      [-4, 0],
      [3, 3],
    ]);
    expect(parts.map((p) => p.text).join("")).toBe("abcdef");
    expect(parts.filter((p) => p.match).map((p) => p.text)).toEqual(["bc", "de", "f"]);
  });

  it("uses UTF-16 offsets, as the backend reports them", () => {
    expect(splitByRanges("😀😀 smile", [[5, 10]]).find((p) => p.match)?.text).toBe("smile");
  });

  it("recognises the backend's building error", () => {
    expect(isIndexBuildingError("IO error: the vault index is still being built; try again")).toBe(
      true,
    );
    expect(isIndexBuildingError(new Error("boom"))).toBe(false);
  });
});

describe("hit places", () => {
  const snippet = { line: 3, inFile: true, text: "t", ranges: [] as [number, number][] };

  it("opens a PDF hit at its page, a file line at its line, extracted text at the file", () => {
    expect(hitLocation({ ...snippet, inFile: false, page: 4 })).toEqual({ kind: "page", page: 4 });
    expect(hitLocation(snippet)).toEqual({ kind: "line", line: 3 });
    expect(hitLocation({ ...snippet, inFile: false })).toEqual({ kind: "file" });
    expect(hitLocation(undefined)).toEqual({ kind: "file" });
  });

  it("labels a snippet with its page or its line, and extracted text with nothing", () => {
    expect(snippetPlace({ ...snippet, inFile: false, page: 4 })).toBe("p4");
    expect(snippetPlace(snippet)).toBe("3");
    expect(snippetPlace({ ...snippet, inFile: false })).toBeNull();
  });
});

describe("ContentSearchPalette", () => {
  let host: HTMLDivElement;
  let root: Root;
  let changed: ((e: { payload: { full: boolean; paths: string[] } }) => void) | null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    changed = null;
    mockedListen.mockImplementation(((_name: string, cb: typeof changed) => {
      changed = cb;
      return Promise.resolve(() => {});
    }) as never);
    mockedInvoke.mockReset();
    listedKinds.current = [];
    mockedOpen.mockResolvedValue(undefined);
    mockedOpenAnchor.mockResolvedValue(undefined);
    // cmdk and Radix expect these browser APIs, which jsdom lacks.
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    Element.prototype.scrollIntoView = () => {};
    useWorkspaceStore.setState({ root: "/ws" });
    useUIStore.setState({
      isCommandPaletteOpen: true,
      commandPaletteIntent: "search-notes",
      commandPaletteSearch: "",
      commandPaletteKind: null,
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

  async function mount() {
    await act(async () => {
      root.render(<ContentSearchPalette />);
    });
  }

  async function type(text: string) {
    const input = document.querySelector("input")!;
    await act(async () => {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!;
      // eslint-disable-next-line typescript/unbound-method -- called with the input as `this`
      Reflect.apply(descriptor.set!, input, [text]);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  async function settle(ms = CONTENT_SEARCH_DEBOUNCE_MS) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  async function key(k: string, opts: KeyboardEventInit = {}) {
    const input = document.querySelector("input")!;
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...opts }));
    });
  }

  const text = () => document.body.textContent ?? "";

  it("lists a name-only .base hit with its extension, ahead of the text hits, and opens it", async () => {
    const base = {
      path: "Bases/Projects/tasks.base",
      title: "tasks",
      folder: "Bases/Projects",
      kind: "base",
      score: 1,
      snippets: [],
      stale: false,
      fuzzy: true,
    } satisfies ContentSearchHit;
    mockedInvoke.mockResolvedValue(
      page(
        base,
        hit("Notes/Plan.md", 2, "open tasks", [[5, 10]]),
        hit("Notes/B.md", 1, "tasks", [[0, 5]]),
      ),
    );
    await mount();
    await type("tasks");
    await settle();
    const rows = [...document.querySelectorAll("[cmdk-item]")];
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain("tasks.base");
    expect(rows[0].textContent).toContain("Bases/Projects");
    await act(async () => {
      (rows[0] as HTMLElement).click();
    });
    expect(mockedOpen).toHaveBeenCalledWith("/ws/Bases/Projects/tasks.base", null, {
      intent: "current",
    });
  });

  it("asks for at least two characters and does not search before that", async () => {
    await mount();
    expect(text()).toContain("Type at least 2 characters");
    await type("a");
    await settle(500);
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it("a clicked tag opens the palette with tag:x and lists the tagged notes, no snippets needed", async () => {
    const tagged = (path: string) => ({ ...hit(path, 1, "", []), snippets: [] });
    mockedInvoke.mockResolvedValue(page(tagged("Notes/Alpha.md"), tagged("Notes/Beta.md")));
    useUIStore.getState().closeCommandPalette();
    await mount();
    await act(async () => activateLink(tagLinkTarget("draft"), "current"));
    await settle();
    expect(mockedInvoke).toHaveBeenCalledWith(
      "index_search",
      expect.objectContaining({ request: expect.objectContaining({ query: "tag:draft" }) }),
    );
    expect(text()).toContain("Alpha");
    expect(text()).toContain("Beta");
    expect(text()).toContain("2 results");
  });

  it("debounces typing into one request for the latest query", async () => {
    mockedInvoke.mockResolvedValue(page(hit("Notes/Harbour.md", 3, "the harbour", [[4, 11]])));
    await mount();
    await type("ha");
    await settle(50);
    await type("har");
    await settle(50);
    await type("harb");
    expect(mockedInvoke).not.toHaveBeenCalled();
    await settle();
    expect(mockedInvoke).toHaveBeenCalledTimes(1);
    expect(mockedInvoke).toHaveBeenCalledWith(
      "index_search",
      expect.objectContaining({
        request: expect.objectContaining({ query: "harb", asYouType: true }),
      }),
    );
    expect(text()).toContain("Harbour");
    expect(text()).toContain("1 result");
  });

  it("leads with the title override (italic, tooltip names the file) and keeps the folder below", async () => {
    mockedInvoke.mockResolvedValue(
      page({
        ...hit("Notes/Spec.md", 0, "", []),
        snippets: [],
        titleOverride: "Quarterly Plan",
      }),
    );
    await mount();
    await type("quarterly");
    await settle();
    const lead = document.querySelector<HTMLElement>("[data-title-override]")!;
    expect(lead.textContent).toBe("Quarterly Plan");
    expect(lead.className).toContain("italic");
    expect(lead.title).toBe("Title override. File: Spec.md");
    expect(text()).toContain("Notes");
  });

  it("shows the file name for a hit without an override", async () => {
    mockedInvoke.mockResolvedValue(page(hit("Notes/Plain.md", 1, "plain", [[0, 5]])));
    await mount();
    await type("plain");
    await settle();
    expect(document.querySelector("[data-title-override]")).toBeNull();
    expect(text()).toContain("Plain");
  });

  it("renders matches as marked React nodes and never injects HTML", async () => {
    const evil = "<img src=x onerror=alert(1)> harbour";
    mockedInvoke.mockResolvedValue(page(hit("Notes/Evil.md", 2, evil, [[29, 36]])));
    await mount();
    await type("harbour");
    await settle();
    expect(document.querySelector("img")).toBeNull();
    expect(text()).toContain("<img src=x onerror=alert(1)>");
    expect(document.querySelector("mark")?.textContent).toBe("harbour");
  });

  it("ignores a slow answer for an older query", async () => {
    let resolveFirst!: (p: ContentSearchPage) => void;
    mockedInvoke
      .mockImplementationOnce(() => new Promise((r) => (resolveFirst = r)))
      .mockResolvedValueOnce(page(hit("New.md", 1, "fresh result", [[0, 5]])));
    await mount();
    await type("old query");
    await settle();
    await type("new query");
    await settle();
    expect(text()).toContain("New");
    await act(async () => {
      resolveFirst(page(hit("Old.md", 1, "stale result", [[0, 5]])));
    });
    expect(text()).toContain("New");
    expect(text()).not.toContain("stale result");
  });

  it("shows loading, empty, error and building states explicitly", async () => {
    let resolve!: (p: ContentSearchPage) => void;
    mockedInvoke.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    await mount();
    await type("zzz");
    await settle();
    expect(text()).toContain("Searching…");
    await act(async () => resolve(page()));
    expect(text()).toContain("No matches");

    mockedInvoke.mockRejectedValueOnce("IO error: disk exploded");
    await type("zzzz");
    await settle();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("disk exploded");

    mockedInvoke.mockRejectedValueOnce("IO error: the vault index is still being built; try again");
    await type("zzzzz");
    await settle();
    expect(text()).toContain("Index is being built…");
  });

  it("retries a search that hit a cold index when the full index change arrives", async () => {
    mockedInvoke
      .mockRejectedValueOnce("IO error: the vault index is still being built; try again")
      .mockResolvedValueOnce(page(hit("Ready.md", 1, "now it works", [[0, 3]])));
    await mount();
    await type("works");
    await settle();
    expect(text()).toContain("Index is being built…");
    await act(async () => {
      changed?.({ payload: { full: false, paths: ["a.md"] } });
    });
    await settle();
    expect(mockedInvoke).toHaveBeenCalledTimes(1); // partial batches do not retry
    await act(async () => {
      changed?.({ payload: { full: true, paths: [] } });
    });
    await settle();
    expect(mockedInvoke).toHaveBeenCalledTimes(2);
    expect(text()).toContain("Ready");
  });

  it("opens the selected hit at its line: Enter in this tab, Cmd+Enter in a new tab", async () => {
    mockedInvoke.mockResolvedValue(
      page(
        hit("A/First.md", 4, "first harbour", [[6, 13]]),
        hit("B/Second.md", 9, "second harbour", [[7, 14]]),
      ),
    );
    await mount();
    await type("harbour");
    await settle();
    await key("Enter");
    expect(mockedOpen).toHaveBeenLastCalledWith("/ws/A/First.md", 4, { intent: "current" });

    useUIStore.setState({ isCommandPaletteOpen: true, commandPaletteSearch: "harbour" });
    await settle();
    await key("ArrowDown");
    await key("Enter", { ctrlKey: true }); // jsdom is not macOS: Ctrl is the modifier
    expect(mockedOpen).toHaveBeenLastCalledWith("/ws/B/Second.md", 9, {
      intent: "new-tab-background",
    });
    expect(useUIStore.getState().isCommandPaletteOpen).toBe(false);
  });

  const KINDS = [
    { id: "note", label: "Notes", icon: "File02Icon" },
    { id: "pdf", label: "PDFs", icon: "Pdf02Icon" },
    { id: "code", label: "Code", icon: "CodeIcon" },
  ];

  const searchRequests = () =>
    mockedInvoke.mock.calls
      .filter(([cmd]) => cmd === "index_search")
      .map(([, args]) => (args as { request: Record<string, unknown> }).request);

  it("shows a chip per listed kind from the registry and narrows the search to the chosen one", async () => {
    listedKinds.current = KINDS;
    mockedInvoke.mockResolvedValue(page(hit("Notes/Plan.md", 1, "budget", [[0, 6]])));
    await mount();
    const chips = [...document.querySelectorAll<HTMLElement>("[data-testid^='kind-chip-']")];
    expect(chips.map((c) => c.textContent)).toEqual(["All", "Notes", "PDFs", "Code"]);
    expect(chips[0].getAttribute("aria-pressed")).toBe("true");
    await type("budget");
    await settle();
    expect(searchRequests().at(-1)).not.toHaveProperty("kinds");
    await act(async () => {
      document.querySelector<HTMLElement>("[data-testid='kind-chip-pdf']")!.click();
    });
    await settle();
    expect(searchRequests().at(-1)).toMatchObject({ query: "budget", kinds: ["pdf"] });
    expect(
      document.querySelector("[data-testid='kind-chip-pdf']")!.getAttribute("aria-pressed"),
    ).toBe("true");
    await act(async () => {
      document.querySelector<HTMLElement>("[data-testid='kind-chip-all']")!.click();
    });
    await settle();
    expect(searchRequests().at(-1)).not.toHaveProperty("kinds");
  });

  it("cycles the chips with Tab and Shift+Tab, wrapping, and never sends a pseudo-kind", async () => {
    listedKinds.current = KINDS;
    mockedInvoke.mockResolvedValue(page(hit("Notes/Plan.md", 1, "budget", [[0, 6]])));
    await mount();
    await type("budget");
    await settle();
    const pressed = () =>
      [...document.querySelectorAll("[data-testid^='kind-chip-']")]
        .filter((c) => c.getAttribute("aria-pressed") === "true")
        .map((c) => c.getAttribute("data-testid"));
    const tab = async (shiftKey = false) => {
      await key("Tab", { shiftKey });
      await settle();
    };
    await tab();
    expect(pressed()).toEqual(["kind-chip-note"]);
    await tab();
    await tab();
    expect(pressed()).toEqual(["kind-chip-code"]);
    await tab();
    expect(pressed()).toEqual(["kind-chip-all"]); // wraps
    await tab(true);
    expect(pressed()).toEqual(["kind-chip-code"]); // and back
    expect(searchRequests().at(-1)).toMatchObject({ kinds: ["code"] });
    expect(document.querySelector("[data-testid='kind-chip-commands']")).toBeNull();
  });

  it("leaves Tab alone when no chips are drawn", async () => {
    listedKinds.current = [KINDS[0]];
    await mount();
    await key("Tab");
    expect(useUIStore.getState().commandPaletteKind).toBeNull();
  });

  it("draws no chips while the vault lists a single kind", async () => {
    listedKinds.current = [KINDS[0]];
    await mount();
    expect(document.querySelector("[data-testid^='kind-chip-']")).toBeNull();
  });

  it("draws each row with the icon the registry names for its kind", async () => {
    listedKinds.current = KINDS;
    mockedInvoke.mockResolvedValue(
      page(
        hit("Notes/Plan.md", 1, "budget", [[0, 6]]),
        { ...hit("Papers/Report.pdf", 1, "budget", [[0, 6]]), kind: "pdf" },
        { ...hit("tools/run.py", 1, "budget", [[0, 6]]), kind: "code" },
      ),
    );
    await mount();
    await type("budget");
    await settle();
    const icons = [...document.querySelectorAll<HTMLElement>("[data-kind-icon]")];
    expect(icons.map((i) => i.dataset.kindIcon)).toEqual(["note", "pdf", "code"]);
  });

  it("opens a PDF hit at the page of its match and an extracted-text hit at the file", async () => {
    mockedInvoke.mockResolvedValue(
      page(
        {
          ...hit("Papers/Report.pdf", 1, "the zebra report", [[4, 9]]),
          kind: "pdf",
          snippets: [
            { line: 7, inFile: false, page: 3, text: "the zebra report", ranges: [[4, 9]] },
          ],
        },
        {
          ...hit("Drawings/Arch.excalidraw", 1, "lighthouse", [[0, 10]]),
          kind: "drawing",
          snippets: [{ line: 2, inFile: false, text: "lighthouse", ranges: [[0, 10]] }],
        },
      ),
    );
    await mount();
    await type("zebra");
    await settle();
    // the page shows in the row
    expect(document.querySelector("[cmdk-item]")!.textContent).toContain("p3");
    await key("Enter");
    expect(mockedOpenAnchor).toHaveBeenLastCalledWith("/ws/Papers/Report.pdf", "page=3", "current");
    expect(mockedOpen).not.toHaveBeenCalled();

    useUIStore.setState({ isCommandPaletteOpen: true, commandPaletteSearch: "zebra" });
    await settle();
    await key("ArrowDown");
    await key("Enter");
    expect(mockedOpen).toHaveBeenLastCalledWith("/ws/Drawings/Arch.excalidraw", null, {
      intent: "current",
    });
  });
});
