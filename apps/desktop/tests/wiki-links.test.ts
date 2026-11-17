import { describe, expect, test, vi } from "vite-plus/test";
import {
  canonicalWikiTarget,
  isWikiLink,
  matchWikiLinkAtStart,
  parseWikiLinkValue,
  WIKI_SUGGEST_TRIGGER,
  wikiLinkInner,
  wikiLinkScanner,
  normalizeWikiTarget,
  parseWikiLink,
  parseWikiImageEmbedTarget,
  resolveWikiImage,
  resolveWikiLink,
  wikiCompletionDisplay,
} from "../src/lib/wiki-links";
import type { SearchResult } from "../src/types/fs";

// ---------------------------------------------------------------------------
// normalizeWikiTarget
// ---------------------------------------------------------------------------

describe("normalizeWikiTarget", () => {
  test("trims whitespace", () => {
    expect(normalizeWikiTarget("  Roadmap  ")).toBe("Roadmap");
  });

  test("normalizes backslashes to forward slashes", () => {
    expect(normalizeWikiTarget("planning\\Roadmap")).toBe("planning/Roadmap");
  });

  test("strips .md extension", () => {
    expect(normalizeWikiTarget("Roadmap.md")).toBe("Roadmap");
  });

  test("strips .markdown extension", () => {
    expect(normalizeWikiTarget("Roadmap.markdown")).toBe("Roadmap");
  });

  test("strips extension case-insensitively", () => {
    expect(normalizeWikiTarget("Roadmap.MD")).toBe("Roadmap");
    expect(normalizeWikiTarget("Roadmap.Markdown")).toBe("Roadmap");
  });

  test("preserves target without extension", () => {
    expect(normalizeWikiTarget("Roadmap")).toBe("Roadmap");
  });

  test("handles combined normalization", () => {
    expect(normalizeWikiTarget("  planning\\Roadmap.md  ")).toBe("planning/Roadmap");
  });

  test("returns empty string for whitespace-only input", () => {
    expect(normalizeWikiTarget("   ")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// parseWikiLink
// ---------------------------------------------------------------------------

describe("parseWikiLink", () => {
  test("splits Obsidian aliases from targets", () => {
    expect(parseWikiLink("No prior experience|I have no prior experience")).toMatchObject({
      path: "No prior experience",
      fragment: null,
      alias: "I have no prior experience",
      displayText: "I have no prior experience",
    });
  });

  test("keeps heading and block fragments out of the file path", () => {
    expect(parseWikiLink("Format your notes#^376b9d|second option")).toMatchObject({
      path: "Format your notes",
      fragment: "^376b9d",
      alias: "second option",
      displayText: "second option",
    });
  });

  test("supports same-file fragment links", () => {
    expect(parseWikiLink("#^0f681f|with great power comes great responsibility")).toMatchObject({
      path: "",
      fragment: "^0f681f",
      alias: "with great power comes great responsibility",
      displayText: "with great power comes great responsibility",
    });
  });

  test("treats table-escaped pipes as Obsidian alias separators", () => {
    expect(parseWikiLink("Format your notes\\|Formatting")).toMatchObject({
      path: "Format your notes",
      alias: "Formatting",
      displayText: "Formatting",
    });
  });
});

// ---------------------------------------------------------------------------
// resolveWikiLink
// ---------------------------------------------------------------------------

function makeResult(overrides: Partial<SearchResult> & { path: string }): SearchResult {
  const path = overrides.path;
  const filename = overrides.filename ?? path.split("/").pop()!;
  return {
    path,
    filename,
    relative_path: overrides.relative_path ?? filename,
    score: overrides.score ?? 100,
    match_indices: overrides.match_indices ?? [],
  };
}

describe("resolveWikiLink", () => {
  // The backend resolver (index/resolve.rs, covered by Rust tests) does the matching; these tests
  // pin what the frontend sends it and how it maps the answer.
  const resolver = (answer: string | null) =>
    vi
      .fn<(target: string, source: string | null) => Promise<string | null>>()
      .mockResolvedValue(answer);

  test("resolves by file name through the backend resolver, from the source note", async () => {
    const resolve = resolver("/vault/Roadmap.md");
    const result = await resolveWikiLink("Roadmap", "/vault/src.md", resolve);
    expect(result).toEqual({ kind: "internal", path: "/vault/Roadmap.md" });
    expect(resolve).toHaveBeenCalledWith("Roadmap", "/vault/src.md");
  });

  test("duplicate names are the backend's call (nearest, shortest, alphabetical), not unresolved", async () => {
    const result = await resolveWikiLink(
      "Callout",
      "/vault/a.md",
      resolver("/vault/Formatting/Callout.md"),
    );
    expect(result).toEqual({ kind: "internal", path: "/vault/Formatting/Callout.md" });
  });

  test("sends the target without .md, alias, heading and block id", async () => {
    const resolve = resolver("/vault/Project Notes/My Note.md");
    await resolveWikiLink("Project Notes/My Note.md#Heading|Label With Spaces", null, resolve);
    expect(resolve).toHaveBeenLastCalledWith("Project Notes/My Note", null);
    await resolveWikiLink("Format your notes#^376b9d|second option", null, resolve);
    expect(resolve).toHaveBeenLastCalledWith("Format your notes", null);
  });

  test("keeps non-markdown names whole (attachments, bases)", async () => {
    const resolve = resolver("/vault/img/Figure 1.png");
    await resolveWikiLink("Figure 1.png", null, resolve);
    expect(resolve).toHaveBeenLastCalledWith("Figure 1.png", null);
  });

  test("a base link carries its #view fragment, a note link does not", async () => {
    expect(await resolveWikiLink("Tasks.base#Active", null, resolver("/vault/Tasks.base"))).toEqual(
      {
        kind: "internal",
        path: "/vault/Tasks.base",
        fragment: "Active",
      },
    );
    expect(await resolveWikiLink("Note#Heading", null, resolver("/vault/Note.md"))).toEqual({
      kind: "internal",
      path: "/vault/Note.md",
    });
  });

  test("unresolved when the backend finds nothing; empty targets never ask", async () => {
    expect(await resolveWikiLink("Missing", null, resolver(null))).toEqual({ kind: "unresolved" });
    const resolve = resolver("/x");
    expect(await resolveWikiLink("  ", null, resolve)).toEqual({ kind: "unresolved" });
    expect(resolve).not.toHaveBeenCalled();
  });

  test("same-file fragment links resolve to the current file without asking", async () => {
    const resolve = resolver(null);
    const result = await resolveWikiLink("#^0f681f|alias", "/vault/Self.md", resolve);
    expect(result).toEqual({ kind: "internal", path: "/vault/Self.md" });
    expect(resolve).not.toHaveBeenCalled();
  });

  test("backend errors (index still building) propagate instead of becoming unresolved", async () => {
    const resolve = vi.fn().mockRejectedValue(new Error("index is still building"));
    await expect(resolveWikiLink("Note", null, resolve)).rejects.toThrow("still building");
  });
});

// ---------------------------------------------------------------------------
// canonicalWikiTarget
// ---------------------------------------------------------------------------

describe("canonicalWikiTarget", () => {
  test("returns bare stem for unique filename", () => {
    const file = makeResult({ path: "/vault/Roadmap.md", relative_path: "Roadmap.md" });
    const allFiles = [file, makeResult({ path: "/vault/Notes.md", relative_path: "Notes.md" })];

    expect(canonicalWikiTarget(file, allFiles)).toBe("Roadmap");
  });

  test("returns relative path for duplicate stems", () => {
    const file = makeResult({
      path: "/vault/planning/Roadmap.md",
      filename: "Roadmap.md",
      relative_path: "planning/Roadmap.md",
    });
    const allFiles = [
      file,
      makeResult({
        path: "/vault/teams/Roadmap.md",
        filename: "Roadmap.md",
        relative_path: "teams/Roadmap.md",
      }),
    ];

    expect(canonicalWikiTarget(file, allFiles)).toBe("planning/Roadmap");
  });

  test("strips .md from relative path for duplicates", () => {
    const file = makeResult({
      path: "/vault/docs/Guide.md",
      filename: "Guide.md",
      relative_path: "docs/Guide.md",
    });
    const allFiles = [
      file,
      makeResult({
        path: "/vault/archive/Guide.md",
        filename: "Guide.md",
        relative_path: "archive/Guide.md",
      }),
    ];

    expect(canonicalWikiTarget(file, allFiles)).toBe("docs/Guide");
  });

  test("preserves spaces and casing in stem", () => {
    const file = makeResult({
      path: "/vault/Art direction ideas.md",
      filename: "Art direction ideas.md",
      relative_path: "Art direction ideas.md",
    });
    const allFiles = [file];

    expect(canonicalWikiTarget(file, allFiles)).toBe("Art direction ideas");
  });

  test("case-insensitive duplicate detection", () => {
    const file = makeResult({
      path: "/vault/a/Notes.md",
      filename: "Notes.md",
      relative_path: "a/Notes.md",
    });
    const allFiles = [
      file,
      makeResult({
        path: "/vault/b/notes.md",
        filename: "notes.md",
        relative_path: "b/notes.md",
      }),
    ];

    expect(canonicalWikiTarget(file, allFiles)).toBe("a/Notes");
  });
});

// ---------------------------------------------------------------------------
// parseWikiImageEmbedTarget
// ---------------------------------------------------------------------------

describe("parseWikiImageEmbedTarget", () => {
  test("accepts supported image extensions case-insensitively", () => {
    expect(parseWikiImageEmbedTarget("diagram.png")).toBe("diagram.png");
    expect(parseWikiImageEmbedTarget("Photo.JPEG")).toBe("Photo.JPEG");
    expect(parseWikiImageEmbedTarget("anim.gif")).toBe("anim.gif");
    expect(parseWikiImageEmbedTarget("icon.svg")).toBe("icon.svg");
  });

  test("normalizes slashes and strips leading slash", () => {
    expect(parseWikiImageEmbedTarget("assets\\pic.png")).toBe("assets/pic.png");
    expect(parseWikiImageEmbedTarget("/assets/pic.png")).toBe("assets/pic.png");
  });

  test("ignores alias and size modifiers after a pipe", () => {
    expect(parseWikiImageEmbedTarget("pic.png|400")).toBe("pic.png");
    expect(parseWikiImageEmbedTarget("pic.png|alt text")).toBe("pic.png");
  });

  test("rejects non-image targets", () => {
    expect(parseWikiImageEmbedTarget("Some Note")).toBeNull();
    expect(parseWikiImageEmbedTarget("Some Note.md")).toBeNull();
    expect(parseWikiImageEmbedTarget("report.pdf")).toBeNull();
    expect(parseWikiImageEmbedTarget(".png")).toBeNull();
    expect(parseWikiImageEmbedTarget("dot.")).toBeNull();
    expect(parseWikiImageEmbedTarget("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveWikiImage
// ---------------------------------------------------------------------------

describe("resolveWikiImage", () => {
  const noFind = vi.fn(async () => null);

  test("resolves path targets workspace-relative first", async () => {
    const fileExists = vi.fn(async (p: string) => p === "/vault/assets/pic.png");
    const result = await resolveWikiImage(
      "assets/pic.png",
      "/vault",
      "/vault/notes/note.md",
      fileExists,
      noFind,
    );
    expect(result).toBe("/vault/assets/pic.png");
  });

  test("falls back to note-relative for path targets", async () => {
    const fileExists = vi.fn(async (p: string) => p === "/vault/notes/assets/pic.png");
    const result = await resolveWikiImage(
      "assets/pic.png",
      "/vault",
      "/vault/notes/note.md",
      fileExists,
      noFind,
    );
    expect(result).toBe("/vault/notes/assets/pic.png");
  });

  test("probes note dir first for bare basenames", async () => {
    const fileExists = vi.fn(async (p: string) => p === "/vault/notes/pic.png");
    const result = await resolveWikiImage(
      "pic.png",
      "/vault",
      "/vault/notes/note.md",
      fileExists,
      noFind,
    );
    expect(result).toBe("/vault/notes/pic.png");
    expect(noFind).not.toHaveBeenCalled();
  });

  test("falls back to workspace basename search for bare names", async () => {
    const fileExists = vi.fn(async () => false);
    const findFileByName = vi.fn(async (root: string, name: string) =>
      root === "/vault" && name === "pic.png" ? "/vault/deep/attachments/pic.png" : null,
    );
    const result = await resolveWikiImage(
      "pic.png",
      "/vault",
      "/vault/notes/note.md",
      fileExists,
      findFileByName,
    );
    expect(result).toBe("/vault/deep/attachments/pic.png");
  });

  test("does not basename-search for path targets", async () => {
    const fileExists = vi.fn(async () => false);
    const findFileByName = vi.fn(async () => "/vault/wrong.png");
    const result = await resolveWikiImage(
      "assets/pic.png",
      "/vault",
      null,
      fileExists,
      findFileByName,
    );
    expect(result).toBeNull();
    expect(findFileByName).not.toHaveBeenCalled();
  });

  test("resolves note-relative without a workspace (compact mode)", async () => {
    const fileExists = vi.fn(async (p: string) => p === "/anywhere/pic.png");
    const result = await resolveWikiImage("pic.png", null, "/anywhere/note.md", fileExists, noFind);
    expect(result).toBe("/anywhere/pic.png");
    expect(noFind).not.toHaveBeenCalled();
  });
});

describe("wiki-link suggestions and titles", () => {
  const result = (over: Partial<SearchResult>): SearchResult => ({
    path: "/ws/People/Spec.md",
    filename: "Spec.md",
    relative_path: "People/Spec.md",
    score: 1,
    match_indices: [],
    ...over,
  });

  test("shows the override, names the file, and still inserts the file name", () => {
    const hit = result({ title: "Quarterly Plan" });
    expect(wikiCompletionDisplay(hit)).toEqual({
      label: "Quarterly Plan",
      detail: "Spec.md · People",
    });
    expect(canonicalWikiTarget(hit, [hit])).toBe("Spec");
  });

  test("shows the file name when there is no override", () => {
    expect(wikiCompletionDisplay(result({ title: null }))).toEqual({
      label: "Spec",
      detail: "People",
    });
  });
});

describe("the [[ ]] grammar helpers", () => {
  test("isWikiLink is true for exactly one bracketed link (trimmed)", () => {
    expect(isWikiLink("[[Note]]")).toBe(true);
    expect(isWikiLink("  [[Note|alias]] ")).toBe(true);
    expect(isWikiLink("[[]]")).toBe(false);
    expect(isWikiLink("[[a]] and [[b]]")).toBe(false);
    expect(isWikiLink("Note")).toBe(false);
  });

  test("wikiLinkInner and parseWikiLinkValue strip the brackets", () => {
    expect(wikiLinkInner(" [[A|b]] ")).toBe("A|b");
    expect(wikiLinkInner("A")).toBe("A");
    expect(parseWikiLinkValue("[[Folder/Note.md#H|shown]]")).toMatchObject({
      path: "Folder/Note",
      fragment: "H",
      alias: "shown",
    });
  });

  test("wikiLinkScanner finds links and embeds, a fresh regexp each call", () => {
    const text = "a [[One]] b ![[img.png]] c [[Two|2]]";
    expect([...text.matchAll(wikiLinkScanner())].map((m) => [m[1], m[2]])).toEqual([
      ["", "One"],
      ["!", "img.png"],
      ["", "Two|2"],
    ]);
    expect(wikiLinkScanner()).not.toBe(wikiLinkScanner());
  });

  test("matchWikiLinkAtStart anchors at the start of the text", () => {
    expect(matchWikiLinkAtStart("[[A#h]] tail")).toEqual({
      raw: "[[A#h]]",
      embed: false,
      inner: "A#h",
    });
    expect(matchWikiLinkAtStart("![[A]]")?.embed).toBe(true);
    expect(matchWikiLinkAtStart("x [[A]]")).toBeNull();
  });

  test("WIKI_SUGGEST_TRIGGER reads the query typed after [[", () => {
    expect(WIKI_SUGGEST_TRIGGER.exec("see [[Pla")?.[1]).toBe("Pla");
    expect(WIKI_SUGGEST_TRIGGER.exec("see [[Plan#")).toBeNull();
    expect(WIKI_SUGGEST_TRIGGER.exec("see [[Plan]] x")).toBeNull();
  });
});
