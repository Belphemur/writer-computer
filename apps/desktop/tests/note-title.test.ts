import { describe, expect, test } from "vite-plus/test";
import { fileTreeLabel } from "../src/components/sidebar/use-file-tree-label";
import { noteLabel } from "../src/lib/note-title";
import type { DirEntry } from "../src/types/fs";

function entry(path: string, title: string | null): DirEntry {
  return {
    name: path.slice(path.lastIndexOf("/") + 1),
    path,
    is_dir: false,
    is_markdown: true,
    modified_at: 0,
    created_at: 0,
    title,
  };
}

describe("noteLabel", () => {
  test("is the file name without the extension", () => {
    expect(noteLabel("/v/Foo Bar.md")).toEqual({
      text: "Foo Bar",
      isOverride: false,
      tooltip: undefined,
    });
    expect(noteLabel("/v/tasks.base").text).toBe("tasks");
  });

  test("a frontmatter title overrides it and is flagged with a tooltip naming the file", () => {
    expect(noteLabel("/v/Foo Bar.md", "Pretty Name")).toEqual({
      text: "Pretty Name",
      isOverride: true,
      tooltip: "Title override. File: Foo Bar.md",
    });
  });

  test("an empty, blank or identical title is not an override", () => {
    for (const t of [null, undefined, "", "   ", "Foo Bar"]) {
      expect(noteLabel("/v/Foo Bar.md", t).isOverride).toBe(false);
      expect(noteLabel("/v/Foo Bar.md", t).text).toBe("Foo Bar");
    }
  });
});

describe("sidebar label", () => {
  test("a note whose H1 differs from its file name shows the file name", () => {
    // The shape of a folder `X` with `X.md` (`# Overview`) and `X/Notes/note.md` (`# Description`):
    // the backend never reports a heading as `title`, so every entry shows its own file name.
    const note = entry("/v/X/Notes/2026-08-31 - Spec.md", null);
    const folderNote = entry("/v/X/X.md", null);
    expect(fileTreeLabel(note).text).toBe("2026-08-31 - Spec");
    expect(fileTreeLabel(folderNote).text).toBe("X");
  });

  test("an override shows the title, marked", () => {
    const label = fileTreeLabel(entry("/v/a.md", "Display"));
    expect(label).toMatchObject({ text: "Display", isOverride: true });
    expect(label.tooltip).toContain("a.md");
  });

  test("folders keep their name", () => {
    const folder = { ...entry("/v/X", "ignored"), is_dir: true };
    expect(fileTreeLabel(folder).text).toBe("X");
  });
});
