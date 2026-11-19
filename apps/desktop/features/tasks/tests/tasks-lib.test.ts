import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vite-plus/test";
import { tasksBlockAt } from "../web/lib/blocks";
import { replaceLineSpec } from "../web/lib/editor-lines";
import { localToday } from "../web/lib/today";
import { applyFieldEdits, valuesOf } from "../web/components/edit-dialog";
import { quickAddFields } from "../web/components/quick-add";

describe("localToday", () => {
  it("is the local calendar day, zero padded", () => {
    expect(localToday(new Date(2024, 0, 5, 23, 59))).toBe("2024-01-05");
    expect(localToday(new Date(2024, 11, 31, 0, 0))).toBe("2024-12-31");
  });
});

describe("replaceLineSpec", () => {
  const state = (doc: string) => EditorState.create({ doc });
  const apply = (doc: string, from: number, expected: string, lines: string[]) => {
    const s = state(doc);
    const spec = replaceLineSpec(s, from, expected, lines);
    return spec ? s.update(spec).state.doc.toString() : null;
  };

  it("replaces the line with one or two lines", () => {
    expect(apply("a\n- [ ] t\nb", 2, "- [ ] t", ["- [x] t"])).toBe("a\n- [x] t\nb");
    expect(apply("a\n- [ ] t\nb", 2, "- [ ] t", ["- [ ] t", "- [x] t"])).toBe(
      "a\n- [ ] t\n- [x] t\nb",
    );
  });

  it("refuses when the line is no longer what it was", () => {
    expect(apply("a\n- [ ] changed\nb", 2, "- [ ] t", ["- [x] t"])).toBeNull();
    expect(apply("a\nb", 99, "x", [])).toBeNull();
    expect(apply("xx\n- [ ] t", 3, "- [ ] t", ["y"])).toBe("xx\ny");
    expect(apply("aa\nbb", 1, "bb", ["y"])).toBeNull(); // offset 1 is inside "aa"
  });

  it("removes the line with one break, also the last line", () => {
    expect(apply("a\nt\nb", 2, "t", [])).toBe("a\nb");
    expect(apply("a\nt", 2, "t", [])).toBe("a");
    expect(apply("t", 0, "t", [])).toBe("");
  });
});

describe("tasksBlockAt", () => {
  const doc = "intro\n```tasks\nnot done\ndue today\n```\nafter\n```js\nx\n```";
  it("finds the block around a position, fences included", () => {
    const at = doc.indexOf("not done");
    const b = tasksBlockAt(doc, at)!;
    expect(b.source).toBe("not done\ndue today");
    expect(doc.slice(b.from, b.to)).toBe("```tasks\nnot done\ndue today\n```");
  });

  it("is null outside the block and for other fences", () => {
    expect(tasksBlockAt(doc, 2)).toBeNull();
    expect(tasksBlockAt(doc, doc.indexOf("after"))).toBeNull();
    expect(tasksBlockAt(doc, doc.indexOf("x\n```"))).toBeNull();
  });

  it("takes an unclosed block to the end of the note", () => {
    const open = "a\n```tasks\nnot done";
    expect(tasksBlockAt(open, open.length)?.source).toBe("not done");
  });
});

describe("quick add and edit dialog helpers", () => {
  it("quickAddFields leaves empty fields out", () => {
    expect(
      quickAddFields({ due: "2024-03-20", scheduled: " ", priority: "high", recurrence: "" }),
    ).toEqual([
      { field: "due", value: "2024-03-20" },
      { field: "priority", value: "high" },
    ]);
  });

  it("applyFieldEdits sets, changes and clears only the fields that differ, in order", async () => {
    const before = valuesOf({
      symbol: " ",
      kind: "todo",
      description: "t",
      due: "2024-03-20",
      scheduled: null,
      start: null,
      priority: "low",
      recurrence: null,
    });
    const calls: string[] = [];
    const set = async (line: string, e: { field: string; value: string | null }) => {
      calls.push(`${e.field}=${e.value}`);
      return `${line}|${e.field}`;
    };
    const out = await applyFieldEdits(
      "L",
      before,
      { ...before, due: "", priority: "low", recurrence: " every week " },
      set,
    );
    expect(calls).toEqual(["due=null", "recurrence=every week"]);
    expect(out).toBe("L|due|recurrence");
    expect(await applyFieldEdits("L", before, before, set)).toBe("L");
  });
});
