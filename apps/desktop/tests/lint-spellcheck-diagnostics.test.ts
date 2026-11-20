// Spelling and lint draw diagnostics in the same editor: neither's re-check without an edit may
// wipe the other's marks (`setDiagnostics` replaces every source's, `replaceOwnDiagnostics` only
// the caller's).
// @vitest-environment jsdom
import { forEachDiagnostic } from "@codemirror/lint";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));

vi.mock("../features/spellcheck/web/ipc", async (original) => ({
  ...(await original<typeof import("../features/spellcheck/web/ipc")>()),
  check: vi.fn(async () => ({
    stale: false,
    blocks: [],
    missing: [],
    findings: [
      {
        start: 0,
        end: 3,
        kind: "spelling",
        message: "m",
        replacements: [],
        ruleId: "SpellCheck",
        provider: "harper",
      },
    ],
  })),
}));
vi.mock("../features/lint/web/ipc", async (original) => ({
  ...(await original<typeof import("../features/lint/web/ipc")>()),
  check: vi.fn(async () => [
    {
      rule: "MD009",
      message: "trailing",
      start: 7,
      end: 10,
      line: 1,
      column: 8,
      severity: "warning",
      safe: true,
      fix: [],
    },
  ]),
}));

import { editorNotePath } from "@/lib/editor-views";
import { useSettingsStore } from "@/stores/settings-store";
import { lintExtension } from "../features/lint/web/editor/linter";
import { LINT_DEBOUNCE_MS } from "../features/lint/web/lib/fix";
import { spellcheckExtension } from "../features/spellcheck/web/editor/linter";
import { useSpellStore } from "../features/spellcheck/web/lib/spell-store";

let view: EditorView | undefined;
afterEach(() => {
  view?.destroy();
  vi.useRealTimers();
  useSpellStore.getState().reset();
  useSettingsStore.setState({ settings: {} });
});

const sources = (v: EditorView) => {
  const out: string[] = [];
  forEachDiagnostic(v.state, (d) => out.push((d.source ?? "").split("\u0000").pop()!));
  return out.sort();
};

async function mount() {
  vi.useFakeTimers();
  view = new EditorView({
    state: EditorState.create({
      doc: "teh cat   \n",
      extensions: [spellcheckExtension(), lintExtension(), editorNotePath.of(() => "/v/a.md")],
    }),
  });
  await vi.advanceTimersByTimeAsync(LINT_DEBOUNCE_MS + 50);
  return view;
}

describe("both features drawing in one editor", () => {
  it("draws both sources", async () => {
    expect(sources(await mount())).toEqual(["MD009", "SpellCheck"]);
  });

  it("a spelling re-check without an edit keeps the lint marks", async () => {
    const v = await mount();
    useSpellStore.getState().bump();
    await vi.advanceTimersByTimeAsync(0);
    expect(sources(v)).toEqual(["MD009", "SpellCheck"]);
  });

  it("a lint re-check without an edit keeps the spelling marks", async () => {
    const v = await mount();
    useSettingsStore.setState({ settings: { "lint.rules-on": ["MD013"] } });
    await vi.advanceTimersByTimeAsync(LINT_DEBOUNCE_MS + 50);
    expect(sources(v)).toEqual(["MD009", "SpellCheck"]);
  });
});
