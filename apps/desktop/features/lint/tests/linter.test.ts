// The editor side: findings drawn as warnings after the typing pause, a re-lint when the rules
// change (with no edit), the per-warning "Fix" placed by a fresh answer, and the cases that ask
// nothing of Rust.
// @vitest-environment jsdom
import { forEachDiagnostic } from "@codemirror/lint";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));

import type { Finding } from "../web/ipc";

const answers: Finding[][] = [];
vi.mock("../web/ipc", async (original) => ({
  ...(await original<typeof import("../web/ipc")>()),
  check: vi.fn(async () => answers.shift() ?? []),
}));

import { editorNotePath } from "@/lib/editor-views";
import { useSettingsStore } from "@/stores/settings-store";
import { lintExtension, toDiagnostics } from "../web/editor/linter";
import { fixFinding, LINT_DEBOUNCE_MS } from "../web/lib/fix";
import { check } from "../web/ipc";

const finding = (patch: Partial<Finding>): Finding => ({
  rule: "MD009",
  message: "3 trailing spaces found",
  start: 1,
  end: 4,
  line: 1,
  column: 2,
  severity: "warning",
  safe: true,
  fix: [{ from: 1, to: 4, insert: "" }],
  ...patch,
});

let view: EditorView | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  answers.length = 0;
  useSettingsStore.setState({ settings: {} });
});
afterEach(() => {
  view?.destroy();
  vi.useRealTimers();
});

const mount = (doc: string, path = "/v/a.md") =>
  (view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [lintExtension(), editorNotePath.of(() => path)],
    }),
  }));

const marks = (v: EditorView) => {
  const out: string[] = [];
  forEachDiagnostic(v.state, (d, from, to) =>
    out.push(`${d.source}:${JSON.stringify(v.state.sliceDoc(from, to))}`),
  );
  return out;
};

describe("toDiagnostics", () => {
  it("maps severity and rule, clamps past the end and widens an empty finding", () => {
    const d = toDiagnostics(
      [
        finding({}),
        finding({ rule: "MD047", start: 5, end: 5, severity: "info", fix: [] }), // a point
        finding({ rule: "MD012", start: 90, end: 99 }), // past the end of a 6-character note
      ],
      6,
    );
    expect(d.map((x) => [x.source, x.severity, x.from, x.to])).toEqual([
      ["MD009", "warning", 1, 4],
      ["MD047", "info", 5, 6],
      // clamped to the end it has no width, so it is drawn on the last character
      ["MD012", "warning", 5, 6],
    ]);
  });
});

describe("the lint source", () => {
  it("draws the findings after the typing pause", async () => {
    vi.useFakeTimers();
    answers.push([finding({})]);
    const v = mount("a   \nb");
    await vi.advanceTimersByTimeAsync(LINT_DEBOUNCE_MS + 50);
    expect(check).toHaveBeenCalledWith("a   \nb");
    expect(marks(v)).toEqual(['MD009:"   "']);
  });

  it("checks only after a full second without an edit, each edit restarting the wait", async () => {
    vi.useFakeTimers();
    const v = mount("a   \nb");
    await vi.advanceTimersByTimeAsync(LINT_DEBOUNCE_MS + 50);
    vi.mocked(check).mockClear();
    v.dispatch({ changes: { from: 0, insert: "x" } });
    await vi.advanceTimersByTimeAsync(LINT_DEBOUNCE_MS - 100);
    v.dispatch({ changes: { from: 0, insert: "y" } });
    await vi.advanceTimersByTimeAsync(LINT_DEBOUNCE_MS - 100);
    expect(check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(150);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("asks nothing for a note that is not Markdown, nor when no rule is on", async () => {
    vi.useFakeTimers();
    mount("a   \nb", "/v/code.ts");
    await vi.advanceTimersByTimeAsync(LINT_DEBOUNCE_MS + 50);
    view!.destroy();
    useSettingsStore.setState({
      settings: {
        "lint.rules-off": ["MD004", "MD009", "MD012", "MD018", "MD019", "MD022", "MD047"],
      },
    });
    mount("a   \nb");
    await vi.advanceTimersByTimeAsync(LINT_DEBOUNCE_MS + 50);
    expect(check).not.toHaveBeenCalled();
  });

  it("lints again when the rules in force change, with no edit", async () => {
    vi.useFakeTimers();
    answers.push([finding({})], []);
    const v = mount("a   \nb");
    await vi.advanceTimersByTimeAsync(LINT_DEBOUNCE_MS + 50);
    expect(marks(v)).toHaveLength(1);
    useSettingsStore.setState({ settings: { "lint.rules-off": ["MD009"] } });
    await vi.advanceTimersByTimeAsync(LINT_DEBOUNCE_MS + 50);
    expect(check).toHaveBeenCalledTimes(2);
    expect(marks(v)).toEqual([]);
    // a setting that does not change the rules does not lint
    useSettingsStore.setState({
      settings: { "lint.rules-off": ["MD009"], "editor.font-size": 18 },
    });
    await vi.advanceTimersByTimeAsync(LINT_DEBOUNCE_MS + 50);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("a failing check draws nothing and does not throw", async () => {
    vi.useFakeTimers();
    vi.mocked(check).mockRejectedValueOnce(new Error("engine down"));
    const v = mount("a   \nb");
    await vi.advanceTimersByTimeAsync(LINT_DEBOUNCE_MS + 50);
    expect(marks(v)).toEqual([]);
  });
});

describe("a warning's Fix", () => {
  it("applies the edits of a fresh answer, found by rule and start", async () => {
    const v = mount("a   \nb");
    answers.push([finding({ rule: "MD012", start: 0, end: 1 }), finding({})]);
    await expect(fixFinding(v, "MD009", 1)).resolves.toBe(true);
    expect(v.state.doc.toString()).toBe("a\nb");
  });

  it("does nothing when the answer no longer has the warning", async () => {
    const v = mount("a\nb");
    answers.push([]);
    await expect(fixFinding(v, "MD009", 1)).resolves.toBe(false);
    expect(v.state.doc.toString()).toBe("a\nb");
  });

  it("does nothing for a warning with no fix, or when the note changed meanwhile", async () => {
    const v = mount("a   \nb");
    answers.push([finding({ fix: [] })]);
    await expect(fixFinding(v, "MD009", 1)).resolves.toBe(false);
    answers.push([finding({})]);
    vi.mocked(check).mockImplementationOnce(async () => {
      v.dispatch({ changes: { from: 0, insert: "z" } }); // typed while the answer was away
      return [finding({})];
    });
    await expect(fixFinding(v, "MD009", 1)).resolves.toBe(false);
    expect(v.state.doc.toString()).toBe("za   \nb");
  });
});
