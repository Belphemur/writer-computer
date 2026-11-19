// The Tasks page draws each section through the real Bases embed with no host note: the query
// carries no `this` (a vault with no Tasks.md must not fail), there is no Edit button, and a
// section's name appears once (the toolbar's view name).
// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));
vi.mock("@/lib/tauri", () => ({
  writeFile: vi.fn(),
  readFile: vi.fn(),
  fileExists: vi.fn(),
  resolveWikiLinkTarget: vi.fn(),
}));
vi.mock("@features/bases/web/ipc", () => ({
  baseList: vi.fn(),
  baseRead: vi.fn(),
  baseParseText: vi.fn(),
  baseQuery: vi.fn(),
  baseQueryText: vi.fn(),
  noteProperties: vi.fn(),
  notePropertySet: vi.fn(),
  notePropertyRemove: vi.fn(),
  onIndexChanged: vi.fn(async () => () => {}),
  baseEval: vi.fn(),
  indexProperties: vi.fn(),
  baseWriteText: vi.fn(),
}));
vi.mock("../web/ipc", () => ({ tasksSections: vi.fn() }));

import * as basesIpc from "@features/bases/web/ipc";
import { EmbeddedBase } from "@features/bases/web/view/embedded";
import { serviceContributions } from "@/lib/features/services";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { baseDocument, taskResult } from "@features/bases/tests/helpers/bases-fixtures";
import { tasksSections } from "../web/ipc";
import { TasksPage } from "../web/components/tasks-page";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SECTIONS = [
  { id: "today", label: "Today", base: "views:\n  - type: table\n    name: Today\n" },
  { id: "overdue", label: "Overdue", base: "views:\n  - type: table\n    name: Overdue\n" },
];

let host: HTMLDivElement;
let root: Root;
let off: (() => void) | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  for (const name of ["clientHeight", "clientWidth"] as const)
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => 600 });
  useWorkspaceStore.setState({ root: "/vault", workspaceEpoch: 1 });
  vi.mocked(tasksSections).mockResolvedValue(SECTIONS);
  vi.mocked(basesIpc.baseParseText).mockResolvedValue({ document: baseDocument(), error: null });
  vi.mocked(basesIpc.baseRead).mockResolvedValue({
    text: "",
    document: baseDocument(),
    error: null,
  });
  // the vault has no Tasks.md: a query naming it as the host fails, as the real index does
  vi.mocked(basesIpc.baseQueryText).mockImplementation(async (args) => {
    if (args.thisPath) throw new Error("`this` file is not in the index: Tasks.md");
    return taskResult();
  });
  off = serviceContributions.add("bases.views", {
    owner: "test",
    id: "bases.views",
    service: { loadEmbeddedBase: async () => EmbeddedBase },
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  off?.();
});

async function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(<TasksPage />);
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
}

describe("Tasks page", () => {
  it("renders the section rows with no host note, no Edit button and one title per section", async () => {
    await mount();
    const calls = vi.mocked(basesIpc.baseQueryText).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(SECTIONS.length);
    for (const [args] of calls) expect(args).not.toHaveProperty("thisPath");
    expect(host.querySelectorAll("[data-base-embed]")).toHaveLength(SECTIONS.length);
    expect(host.textContent).toContain("alpha");
    expect(host.querySelector("[data-base-error]")).toBeNull();
    expect(host.querySelector("[data-embed-edit]")).toBeNull();
    expect(host.querySelector("h2")).toBeNull();
    expect(host.querySelectorAll("section[aria-label='Today']")).toHaveLength(1);
  });
});
