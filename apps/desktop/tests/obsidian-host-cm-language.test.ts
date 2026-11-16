// Plugins call `node.type.prop(language.tokenClassNodeProp)` (an Obsidian-only export of
// `@codemirror/language`); `undefined` there crashed their CodeMirror view plugin.
import { describe, expect, it } from "vite-plus/test";
import { markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { makeRequire } from "../src/lib/obsidian-host/modules";

describe("@codemirror/language compat", () => {
  it("exports tokenClassNodeProp and nodes read it as undefined", () => {
    const req = makeRequire({} as never, {} as never);
    const lang = req("@codemirror/language") as { tokenClassNodeProp: never };
    expect(lang.tokenClassNodeProp).toBeDefined();
    const state = EditorState.create({ doc: "# Title\n[[x]]", extensions: [markdownLanguage] });
    let seen = 0;
    syntaxTree(state).iterate({
      enter: (n) => {
        expect(n.type.prop(lang.tokenClassNodeProp)).toBeUndefined();
        seen++;
      },
    });
    expect(seen).toBeGreaterThan(0);
  });
});
