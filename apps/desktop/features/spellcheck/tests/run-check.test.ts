// Writer's checker runs whenever the feature is on, whatever Obsidian plugin is running.
// @vitest-environment jsdom
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const check = vi.hoisted(() => vi.fn());
vi.mock("../web/ipc", () => ({ check, addWord: vi.fn(), ignoreWord: vi.fn() }));

import { setRunningCommunityPlugins } from "@/lib/community-plugins";
import { editorNotePath } from "@/lib/editor-views";
import { runCheck } from "../web/editor/linter";

afterEach(() => {
  setRunningCommunityPlugins([]);
  check.mockReset();
});

describe("runCheck", () => {
  it("checks the note while a LanguageTool plugin is reported running", async () => {
    setRunningCommunityPlugins(["obsidian-languagetool-plugin"]);
    check.mockResolvedValue({ stale: false, findings: [], blocks: [], missing: [] });
    const view = new EditorView({
      state: EditorState.create({
        doc: "Teh cat.",
        extensions: [editorNotePath.of(() => "/vault/a.md")],
      }),
    });
    await runCheck(view);
    expect(check).toHaveBeenCalledTimes(1);
    view.destroy();
  });
});
