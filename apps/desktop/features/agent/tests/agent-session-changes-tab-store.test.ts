import { describe, expect, it } from "vite-plus/test";
import { openSessionChangesTab } from "@/hooks/editor-api";
import { createSessionChangesTab, useEditorStore } from "@/stores/editor-store";

describe("the Session changes tab in the editor store", () => {
  it("opens one tab per chat and re-targets it", () => {
    useEditorStore.setState({ tabs: [], activeTabId: null });
    openSessionChangesTab({ chatId: "c1", focus: "a.md" });
    openSessionChangesTab({ chatId: "c1", focus: "b.md" });
    openSessionChangesTab({ chatId: "c2" });
    const tabs = useEditorStore.getState().tabs.map((t) => t.location);
    expect(tabs).toEqual([
      { kind: "session-changes", chatId: "c1", focus: "b.md" },
      { kind: "session-changes", chatId: "c2" },
    ]);
    expect(createSessionChangesTab({ chatId: "x" }).location.kind).toBe("session-changes");
  });
});
