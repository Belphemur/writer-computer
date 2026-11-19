// Inline `:shortcodes:`: which text is one, the widget CodeMirror draws for it (not under the
// caret, not in code, not for text that merely looks like one), and the completion after `:` and
// two letters. The text always stays in the document. Spec: SPECs/icons-spec.md.
// @vitest-environment jsdom
import { markdown } from "@codemirror/lang-markdown";
import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));

import { contributedCompletions } from "@/lib/editor-completion-sources";
import { emojiShortcode, shortcodeValue, shortcodesExtension } from "../web/shortcodes";

const EMOJIS = new Map([
  ["rocket", "🚀"],
  ["grinning_face", "😀"],
]);

describe("shortcodeValue", () => {
  it("names a Hugeicons export and an emoji, nothing else", () => {
    expect(shortcodeValue("Rocket01Icon", EMOJIS)).toBe("icon:Rocket01Icon");
    expect(shortcodeValue("rocket", EMOJIS)).toBe("emoji:🚀");
    expect(shortcodeValue("Rocket", EMOJIS)).toBe("emoji:🚀");
    expect(shortcodeValue("grinning_face", EMOJIS)).toBe("emoji:😀");
    expect(shortcodeValue("30", EMOJIS)).toBeNull();
    expect(shortcodeValue("nothing", EMOJIS)).toBeNull();
    expect(shortcodeValue("rocket01Icon", EMOJIS)).toBeNull();
  });

  it("an emoji shortcode is its name in words joined with _", () => {
    expect(emojiShortcode("grinning face")).toBe("grinning_face");
    expect(emojiShortcode("flag: France")).toBe("flag_france");
    expect(emojiShortcode("1st place medal")).toBe("1st_place_medal");
  });
});

describe("the editor extension", () => {
  const views: EditorView[] = [];
  afterEach(() => {
    for (const v of views.splice(0)) v.destroy();
  });

  async function editor(doc: string, caret = doc.length) {
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc,
        selection: { anchor: caret },
        extensions: [markdown(), await shortcodesExtension()],
      }),
    });
    views.push(view);
    return view;
  }
  const widgets = (v: EditorView) =>
    [...v.dom.querySelectorAll<HTMLElement>(".cm-icon-shortcode")].map((w) => w.dataset.iconValue);

  it("replaces an emoji shortcode and a Hugeicons shortcode with their icon, text kept", async () => {
    const doc = "a :rocket: and :Rocket01Icon: here\n\nend";
    const view = await editor(doc, doc.length);
    expect(widgets(view)).toEqual(["emoji:🚀", "icon:Rocket01Icon"]);
    expect(view.state.doc.toString()).toBe(doc);
  });

  it("shows the text again under the caret", async () => {
    const doc = "a :rocket: b\n\nend";
    const view = await editor(doc, 5);
    expect(widgets(view)).toEqual([]);
    view.dispatch({ selection: { anchor: doc.length } });
    expect(widgets(view)).toEqual(["emoji:🚀"]);
  });

  it("leaves code, times and unknown names alone", async () => {
    const doc = "`:rocket:` at 12:30:45 and :nothing:\n\n```\n:rocket:\n```\n\nend";
    const view = await editor(doc);
    expect(widgets(view)).toEqual([]);
  });

  it("completes after a colon and two letters with emoji and icons, and never mid-word or in code", async () => {
    const ext = await shortcodesExtension();
    const ask = (doc: string) => {
      const s = EditorState.create({
        doc,
        selection: { anchor: doc.length },
        extensions: [markdown(), ext],
      });
      return contributedCompletions(new CompletionContext(s, doc.length, false));
    };
    const rocket = await ask("hello :rock");
    expect(rocket?.from).toBe(6);
    const labels = rocket!.options.map((o) => o.label);
    expect(labels).toContain(":rocket:");
    expect(labels.some((l) => /^:Rocket\w*Icon:$/.test(l))).toBe(true);
    expect(await ask("hello :r")).toBeNull();
    expect(await ask("a:rock")).toBeNull();
    expect(await ask("hello rock")).toBeNull();
    expect(await ask("```\n:rock")).toBeNull();
  });
});
