// The task rows of a `rows: tasks` base: the checkbox is written by the tasks feature (through
// its service, never as frontmatter), every other `task.*` cell is read-only, a file base keeps
// `task.x` as an ordinary note property, and the checkbox is read-only while the feature is off.
// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../web/ipc", () => ({
  baseList: vi.fn(),
  baseRead: vi.fn(),
  baseQuery: vi.fn(),
  baseQueryText: vi.fn(),
  noteProperties: vi.fn(),
  notePropertySet: vi.fn(),
  notePropertyRemove: vi.fn(),
  onIndexChanged: vi.fn(),
  baseEval: vi.fn(),
  indexProperties: vi.fn(),
  baseWriteText: vi.fn(),
}));

import { BaseView } from "../web/view";
import * as ipc from "../web/ipc";
import { editTargetFor, isTaskRowColumn, READ_ONLY_REASONS } from "../web/lib/cells";
import type { BaseQueryResult } from "../web/lib/types";
import { serviceContributions } from "@/lib/features/services";
import { useEditorStore } from "@/stores/editor-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { BASE_PATH, baseDocument, bool, column, date, str } from "./helpers/bases-fixtures";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const columns = [
  column("task.checked", "Done"),
  column("task.description", "Task"),
  column("task.due", "Due"),
];
const taskRows = (): BaseQueryResult => ({
  view: { name: "Table", type: "table", index: 0 },
  availableViews: ["Table"],
  columns,
  rows: [
    { path: "Notes/a.md", line: 4, cells: [bool(false), str("Write"), date("2024-03-20")] },
    { path: "Notes/a.md", line: 9, cells: [bool(false), str("Send"), date("2024-03-21")] },
  ],
  groups: null,
  summaries: columns.map(() => null),
  totalMatched: 2,
  error: null,
  warnings: [],
});

const toggle = vi.fn(async () => ({ path: "Notes/a.md", lines: [4] }));
let host: HTMLDivElement;
let root: Root;

const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const box = (line: number) =>
  host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[line === 4 ? 0 : 1]!;

function provideService() {
  serviceContributions.add("tasks.rows", {
    owner: "builtin:tasks",
    id: "tasks.rows",
    service: { toggle },
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  for (const name of ["clientHeight", "clientWidth"] as const)
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => 800 });
  vi.mocked(ipc.baseRead).mockResolvedValue({ text: "", document: baseDocument(), error: null });
  vi.mocked(ipc.baseQuery).mockImplementation(async () => taskRows());
  vi.mocked(ipc.onIndexChanged).mockResolvedValue(() => {});
  useWorkspaceStore.setState({ root: "/vault", workspaceEpoch: 1 });
  useEditorStore.setState({
    openFiles: new Map(),
    tabs: [],
    activeTabId: null,
    activeFilePath: null,
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

/** Mount the view; the service is registered first because cells read their state at render. */
async function mount(withService: boolean) {
  if (withService) provideService();
  await act(async () => {
    root.render(<BaseView location={{ kind: "base", path: BASE_PATH }} isActive tabId="t" />);
  });
  await flush();
}

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  serviceContributions.removeOwner("builtin:tasks");
});

describe("cells", () => {
  it("a task row's task.* columns are the task's; a file row's are note properties", () => {
    const [checked, , due] = columns as [(typeof columns)[0], unknown, (typeof columns)[2]];
    const taskRow = taskRows().rows[0]!;
    const fileRow = { path: "Notes/a.md", cells: taskRow.cells };
    expect(isTaskRowColumn(checked, taskRow)).toBe(true);
    expect(isTaskRowColumn(checked, fileRow)).toBe(false);
    expect(editTargetFor(checked, taskRow.cells[0]!, [taskRow], 0, taskRow)).toEqual({
      editable: true,
      kind: "checkbox",
    });
    expect(editTargetFor(due, taskRow.cells[2]!, [taskRow], 2, taskRow)).toEqual({
      editable: false,
      reason: READ_ONLY_REASONS.task,
    });
    expect(editTargetFor(due, fileRow.cells[2]!, [fileRow], 2, fileRow).editable).toBe(true);
  });
});

describe("the checkbox", () => {
  it("is written by the tasks service with the path, line and listed description", async () => {
    await mount(true);
    await act(async () => box(9).click());
    await flush();
    expect(toggle).toHaveBeenCalledWith({ path: "Notes/a.md", line: 9, expect: "Send" });
    expect(ipc.notePropertySet).not.toHaveBeenCalled();
    expect(ipc.notePropertyRemove).not.toHaveBeenCalled();
    // the table requeries after the write
    expect(vi.mocked(ipc.baseQuery).mock.calls.length).toBeGreaterThan(1);
  });

  it("is read-only while the tasks feature is off", async () => {
    await mount(false);
    expect(box(4).disabled).toBe(true);
    expect(box(4).title).toBe(READ_ONLY_REASONS.tasksOff);
    await act(async () => box(4).click());
    expect(toggle).not.toHaveBeenCalled();
    expect(ipc.notePropertySet).not.toHaveBeenCalled();
  });
});

describe("other task fields", () => {
  it("never write frontmatter", async () => {
    await mount(true);
    const due = host.querySelector<HTMLElement>(
      '[data-row-path="Notes/a.md"] [aria-colindex="3"]',
    )!;
    await act(async () => {
      due.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      due.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      host
        .querySelector('[role="grid"]')!
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
        );
    });
    await flush();
    expect(ipc.notePropertySet).not.toHaveBeenCalled();
    expect(host.textContent).toContain(READ_ONLY_REASONS.task);
  });
});
