// The pure parts of the web half: diagnostics, the language property edit, language names and the
// settings readers (including which checker runs next to LanguageTool).
// @vitest-environment jsdom
import { setDiagnostics, type Diagnostic } from "@codemirror/lint";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { setRunningCommunityPlugins } from "@/lib/community-plugins";
import { editorNotePath } from "@/lib/editor-views";
import { toDiagnostics, MAX_REPLACEMENTS } from "../web/editor/diagnostics";
import { languagePropertyChange } from "../web/lib/lang-property";
import { blockAt, languageName } from "../web/lib/languages";
import {
  anyKindEnabled,
  checkSignature,
  ignoredRules,
  KEYS,
  LANGUAGETOOL_PLUGIN_ID,
  languageToolChoice,
  writerCheckerActive,
} from "../web/lib/settings";
import type { Finding } from "../web/ipc";

const finding = (over: Partial<Finding> = {}): Finding => ({
  start: 0,
  end: 4,
  kind: "spelling",
  message: "Possible misspelling",
  replacements: ["a", "b", "c", "d", "e", "f"],
  ruleId: "SpellCheck",
  provider: "harper",
  ...over,
});

describe("diagnostics", () => {
  const lintState: Extension[] = [];
  const handlers = { addWord: vi.fn(), ignoreWord: vi.fn(), ignoreRule: vi.fn() };

  const cardOf = (d: Diagnostic, view: EditorView) => d.renderMessage!(view) as HTMLElement;
  const chips = (card: HTMLElement) => [...card.querySelectorAll<HTMLButtonElement>("button")];

  it("maps severity and clamps offsets, with no default actions", () => {
    const [d, s] = toDiagnostics(
      [finding(), finding({ kind: "style", ruleId: "Wordy", start: 2, end: 99 })],
      10,
      handlers,
    );
    expect(d!.severity).toBe("warning");
    expect(s).toMatchObject({ severity: "info", from: 2, to: 10 });
    expect(d!.actions).toBeUndefined();
  });

  it("drops a finding that fell past the end of the document", () => {
    expect(toDiagnostics([finding({ start: 20, end: 25 })], 10, handlers)).toEqual([]);
  });

  it("renders a kind icon, the title, the message and word-only chips", () => {
    const view = new EditorView({ state: EditorState.create({ doc: "x" }) });
    const [d, s] = toDiagnostics(
      [finding(), finding({ kind: "style", ruleId: "Wordy", replacements: ["", "x"] })],
      10,
      handlers,
    );
    const card = cardOf(d!, view);
    expect(card.querySelector(".cm-spell-head svg")).not.toBeNull();
    expect(card.querySelector(".cm-spell-title")!.textContent).toBe("Spelling");
    expect(card.querySelector(".cm-spell-message")!.textContent).toBe("Possible misspelling");
    const labels = chips(card).map((b) => b.textContent);
    expect(labels).toEqual(["a", "b", "c", "d", "e", "Add to dictionary", "Ignore"]);
    expect(labels.length - 2).toBe(MAX_REPLACEMENTS);
    expect(chips(card).at(-1)!.querySelector("svg")).not.toBeNull();
    const style = cardOf(s!, view);
    expect(chips(style).map((b) => b.textContent)).toEqual(["Remove", "x", "Ignore rule"]);
    expect(chips(style)[0]!.querySelector("svg")).not.toBeNull();
    view.destroy();
  });

  it("replace edits the text at the mapped range, add-word and ignore-rule call the handlers", () => {
    const state = EditorState.create({ doc: "teh cat", extensions: [lintState] });
    const view = new EditorView({ state });
    const [d] = toDiagnostics([finding({ end: 3, replacements: ["the"] })], 7, handlers);
    view.dispatch(setDiagnostics(view.state, [d!]));
    // an edit before the word after the check: the range maps
    view.dispatch({ changes: { from: 0, insert: ">> " } });
    const card = cardOf(d!, view);
    chips(card)[0]!.click();
    expect(view.state.doc.toString()).toBe(">> the cat");
    chips(card).at(-2)!.click();
    expect(handlers.addWord).toHaveBeenCalled();
    const [g] = toDiagnostics([finding({ ruleId: "ShouldOf", kind: "grammar" })], 7, handlers);
    chips(cardOf(g!, view)).at(-1)!.click();
    expect(handlers.ignoreRule).toHaveBeenCalledWith("ShouldOf");
    view.destroy();
  });

  describe("the Ignore chip", () => {
    const card = (kind: "spelling" | "grammar", extensions: Extension[]) => {
      const view = new EditorView({ state: EditorState.create({ doc: "teh cat", extensions }) });
      const over = kind === "grammar" ? { kind, ruleId: "ShouldOf" } : {};
      const [d] = toDiagnostics([finding({ end: 3, ...over })], 7, handlers);
      view.dispatch(setDiagnostics(view.state, [d!]));
      return { view, card: cardOf(d!, view) };
    };

    it("is on a misspelled word only, and ignores that word in the note the editor shows", () => {
      handlers.ignoreWord.mockClear();
      const { view, card: spelling } = card("spelling", [
        lintState,
        editorNotePath.of(() => "/v/a.md"),
      ]);
      const ignore = chips(spelling).find((b) => b.textContent === "Ignore")!;
      expect(ignore.querySelector("svg")).not.toBeNull();
      ignore.click();
      expect(handlers.ignoreWord).toHaveBeenCalledWith("teh", "/v/a.md");
      expect(chips(card("grammar", [lintState]).card).map((b) => b.textContent)).not.toContain(
        "Ignore",
      );
      view.destroy();
    });

    it("does nothing in an editor with no note", () => {
      handlers.ignoreWord.mockClear();
      const { view, card: spelling } = card("spelling", [lintState]);
      chips(spelling)
        .find((b) => b.textContent === "Ignore")!
        .click();
      expect(handlers.ignoreWord).not.toHaveBeenCalled();
      view.destroy();
    });
  });
});

describe("languagePropertyChange", () => {
  const apply = (text: string, tag: string) => {
    const c = languagePropertyChange(text, tag);
    return text.slice(0, c.from) + c.insert + text.slice(c.to);
  };

  it("creates, extends and replaces front matter", () => {
    expect(apply("Hello", "fr")).toBe("---\nlang: fr\n---\n\nHello");
    expect(apply("---\ntitle: x\n---\nHi", "fr")).toBe("---\ntitle: x\nlang: fr\n---\nHi");
    expect(apply("---\nlanguage: de\ntitle: x\n---\nHi", "fr")).toBe(
      "---\nlang: fr\ntitle: x\n---\nHi",
    );
  });

  it("keeps CRLF and ignores an unclosed block", () => {
    expect(apply("---\r\ntitle: x\r\n---\r\nHi", "fr")).toBe(
      "---\r\ntitle: x\r\nlang: fr\r\n---\r\nHi",
    );
    expect(apply("---\nnot closed", "fr").startsWith("---\nlang: fr\n---\n\n---")).toBe(true);
  });
});

describe("languages", () => {
  it("names tags and falls back to the tag", () => {
    expect(languageName("fr")).toBe("French");
    expect(languageName("not a tag!")).toBe("not a tag!");
  });

  it("finds the block at the cursor, the closest before it, or the first", () => {
    const b = (start: number, end: number, lang: string) =>
      ({ start, end, lang, source: "default" }) as never;
    const blocks = [b(5, 10, "en"), b(20, 30, "fr")];
    expect(blockAt(blocks, 22)).toMatchObject({ lang: "fr" });
    expect(blockAt(blocks, 15)).toMatchObject({ lang: "en" });
    expect(blockAt(blocks, 0)).toMatchObject({ lang: "en" });
    expect(blockAt([], 0)).toBeNull();
    expect(blockAt(undefined, 0)).toBeNull();
  });
});

describe("settings readers", () => {
  beforeEach(() => setRunningCommunityPlugins([]));

  it("reads the defaults and the stored values", () => {
    expect(anyKindEnabled({})).toBe(true);
    expect(anyKindEnabled({ [KEYS.spelling]: false, [KEYS.grammar]: false })).toBe(false);
    expect(
      anyKindEnabled({ [KEYS.spelling]: false, [KEYS.grammar]: false, [KEYS.style]: true }),
    ).toBe(true);
    expect(languageToolChoice({})).toBe("ask");
    expect(languageToolChoice({ [KEYS.languageTool]: "both" })).toBe("both");
    expect(languageToolChoice({ [KEYS.languageTool]: "nonsense" })).toBe("ask");
    expect(ignoredRules({ [KEYS.ignoredRules]: ["A", 3] })).toEqual(["A"]);
    expect(checkSignature({})).not.toBe(checkSignature({ [KEYS.style]: true }));
  });

  it("yields to LanguageTool only when chosen and the plugin runs", () => {
    const chosen = { [KEYS.languageTool]: "languagetool" };
    expect(writerCheckerActive(chosen)).toBe(true);
    setRunningCommunityPlugins([LANGUAGETOOL_PLUGIN_ID]);
    expect(writerCheckerActive(chosen)).toBe(false);
    expect(writerCheckerActive({})).toBe(true);
    expect(writerCheckerActive({ [KEYS.languageTool]: "both" })).toBe(true);
  });
});
