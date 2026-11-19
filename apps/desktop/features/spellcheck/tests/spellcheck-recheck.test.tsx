// A re-check with no edit (a word added, a setting changed: `epoch` goes up) really runs the
// checker and draws its answer. `forceLinting` would do nothing here: it only hurries a check an
// edit already scheduled.
// @vitest-environment jsdom
import { forEachDiagnostic } from "@codemirror/lint";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));

const answers: { start: number; end: number }[][] = [];
vi.mock("../web/ipc", async (original) => ({
  ...(await original<typeof import("../web/ipc")>()),
  check: vi.fn(async () => ({
    stale: false,
    blocks: [],
    missing: [],
    findings: (answers.shift() ?? []).map((r) => ({
      ...r,
      kind: "spelling",
      message: "m",
      replacements: [],
      ruleId: "SpellCheck",
      provider: "harper",
    })),
  })),
}));

import { editorNotePath } from "@/lib/editor-views";
import { check } from "../web/ipc";
import { CHECK_DELAY_MS, spellcheckExtension } from "../web/editor/linter";
import { useSpellStore } from "../web/lib/spell-store";

let view: EditorView | undefined;
afterEach(() => {
  view?.destroy();
  vi.useRealTimers();
  useSpellStore.getState().reset();
});

const ranges = (v: EditorView) => {
  const out: string[] = [];
  forEachDiagnostic(v.state, (_d, from, to) => out.push(v.state.sliceDoc(from, to)));
  return out;
};

describe("a re-check without an edit", () => {
  it("runs the checker when epoch goes up and updates the underlines and the footer", async () => {
    vi.useFakeTimers();
    answers.push([{ start: 0, end: 3 }], []);
    view = new EditorView({
      state: EditorState.create({
        doc: "teh cat",
        extensions: [spellcheckExtension(), editorNotePath.of(() => "/v/a.md")],
      }),
    });
    await vi.advanceTimersByTimeAsync(CHECK_DELAY_MS + 50);
    expect(ranges(view)).toEqual(["teh"]);
    expect(useSpellStore.getState().results["/v/a.md"]?.groups).toHaveLength(1);

    useSpellStore.getState().bump();
    await vi.advanceTimersByTimeAsync(0);
    expect(check).toHaveBeenCalledTimes(2);
    expect(ranges(view)).toEqual([]);
    expect(useSpellStore.getState().results["/v/a.md"]?.groups).toEqual([]);
  });
});
