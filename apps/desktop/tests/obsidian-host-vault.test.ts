import { describe, expect, it, vi } from "vite-plus/test";
import { Editor, type EditorBackend } from "../src/lib/obsidian-host/api/views";
import {
  debounce,
  moment,
  normalizePath,
  parseFrontMatterAliases,
  parseFrontMatterTags,
  parseYaml,
  prepareFuzzySearch,
  requireApiVersion,
  stringifyYaml,
} from "../src/lib/obsidian-host/api/functions";
import {
  MetadataCache,
  parseNoteMetadata,
  TFile,
  TFolder,
  Vault,
  getAllTags,
} from "../src/lib/obsidian-host/api/vault";
import { pathShim } from "../src/lib/obsidian-host/node-shims";
import { createMemoryVaultIo } from "../src/lib/obsidian-host/testing";

describe("normalizePath", () => {
  it.each([
    ["a/b.md", "a/b.md"],
    ["/a//b/", "a/b"],
    ["a\\b\\c.md", "a/b/c.md"],
    ["", "/"],
    ["/", "/"],
    ["///", "/"],
    ["a b/c", "a b/c"],
  ])("%j -> %j", (input, expected) => {
    expect(normalizePath(input)).toBe(expected);
  });
});

describe("parseNoteMetadata", () => {
  const note = [
    "---",
    "title: Hello",
    "tags: [alpha, beta]",
    "aliases:",
    "  - Hi",
    "---",
    "# Heading One",
    "Body with [[Other Note]] and [[Folder/Deep#Section|shown]] and #inline-tag.",
    "![[image.png]] and [md](other%20file.md) and [web](https://example.com).",
    "",
    "```",
    "[[not a link]] #not-a-tag",
    "```",
    "Inline `[[nope]]` code.",
    "## Second",
    "",
  ].join("\n");
  const meta = parseNoteMetadata(note);

  it("parses frontmatter and its position", () => {
    expect(meta.frontmatter).toEqual({ title: "Hello", tags: ["alpha", "beta"], aliases: ["Hi"] });
    expect(meta.frontmatterPosition?.start).toEqual({ line: 0, col: 0, offset: 0 });
    expect(meta.frontmatterPosition?.end.line).toBe(5);
  });

  it("finds wiki and markdown links, ignoring code and external urls", () => {
    expect(meta.links?.map((l) => l.link)).toEqual([
      "Other Note",
      "Folder/Deep#Section",
      "other file.md",
    ]);
    expect(meta.links?.[1].displayText).toBe("shown");
    expect(meta.embeds?.map((l) => l.link)).toEqual(["image.png"]);
  });

  it("reports offsets that index into the original text", () => {
    const l = meta.links![0];
    expect(note.slice(l.position.start.offset, l.position.end.offset)).toBe("[[Other Note]]");
    expect(l.position.start.line).toBe(7);
  });

  it("finds tags outside code and headings with levels", () => {
    expect(meta.tags?.map((t) => t.tag)).toEqual(["#inline-tag"]);
    expect(meta.headings?.map((h) => [h.level, h.heading])).toEqual([
      [1, "Heading One"],
      [2, "Second"],
    ]);
    expect(getAllTags(meta)?.sort()).toEqual(["#alpha", "#beta", "#inline-tag"]);
  });

  it("copes with invalid yaml and no frontmatter", () => {
    expect(parseNoteMetadata("---\n: : bad: [\n---\nbody [[x]]").links?.[0].link).toBe("x");
    expect(parseNoteMetadata("---\n: : bad: [\n---\n").frontmatter).toBeUndefined();
    expect(parseNoteMetadata("plain").frontmatter).toBeUndefined();
    expect(parseNoteMetadata("# 1 not a tag #123").tags).toBeUndefined();
  });
});

describe("Vault over a VaultIo", () => {
  async function makeVault() {
    const io = createMemoryVaultIo({
      "Home.md": "# Home\n[[Projects/Plan]] [[Missing]]",
      "Projects/Plan.md": "---\ntags: plan\n---\nSee [[Home]]",
      "Projects/notes.txt": "x",
      ".obsidian/app.json": "{}",
    });
    const vault = new Vault(io);
    await vault.load();
    return { io, vault };
  }

  it("indexes files and folders, hiding dot-folders", async () => {
    const { vault } = await makeVault();
    expect(
      vault
        .getMarkdownFiles()
        .map((f) => f.path)
        .sort(),
    ).toEqual(["Home.md", "Projects/Plan.md"]);
    expect(
      vault
        .getFiles()
        .map((f) => f.path)
        .sort(),
    ).toEqual(["Home.md", "Projects/Plan.md", "Projects/notes.txt"]);
    expect(vault.getAbstractFileByPath(".obsidian/app.json")).toBeNull();
    const plan = vault.getFileByPath("Projects/Plan.md")!;
    expect(plan).toBeInstanceOf(TFile);
    expect(plan.basename).toBe("Plan");
    expect(plan.extension).toBe("md");
    expect(plan.parent).toBeInstanceOf(TFolder);
    expect(plan.parent?.path).toBe("Projects");
    expect(vault.getRoot().isRoot()).toBe(true);
    expect(vault.getFolderByPath("Projects")?.children).toHaveLength(2);
  });

  it("create/modify/rename/delete update the model and fire events", async () => {
    const { vault, io } = await makeVault();
    const events: string[] = [];
    for (const name of ["create", "modify", "rename", "delete"]) {
      vault.on(
        name,
        (f: { path: string }, old?: string) =>
          void events.push(`${name}:${f.path}${old ? `<${old}` : ""}`),
      );
    }
    const f = await vault.create("New/Deep/a.md", "hello");
    expect(io.files.get("New/Deep/a.md")).toBe("hello");
    expect(vault.getFolderByPath("New/Deep")).not.toBeNull();
    await vault.modify(f, "changed");
    expect(await vault.read(f)).toBe("changed");
    await vault.rename(f, "New/b.md");
    expect(f.path).toBe("New/b.md");
    expect(vault.getAbstractFileByPath("New/Deep/a.md")).toBeNull();
    await vault.delete(f);
    expect(vault.getAbstractFileByPath("New/b.md")).toBeNull();
    expect(events).toEqual([
      "create:New/Deep/a.md",
      "modify:New/Deep/a.md",
      "rename:New/b.md<New/Deep/a.md",
      "delete:New/b.md",
    ]);
    await expect(vault.create("Home.md", "")).rejects.toThrow(/already exists/);
  });

  it("notifyExternal reflects watcher events without double-firing own writes", async () => {
    const { vault, io } = await makeVault();
    const modify = vi.fn();
    vault.on("modify", modify);
    io.files.set("Home.md", "external");
    await vault.notifyExternal("modify", "Home.md");
    expect(modify).toHaveBeenCalledTimes(1);
    io.files.set("Late.md", "x");
    await vault.notifyExternal("create", "Late.md");
    expect(vault.getFileByPath("Late.md")).not.toBeNull();
    await vault.notifyExternal("create", ".obsidian/x.json");
    expect(vault.getAbstractFileByPath(".obsidian/x.json")).toBeNull();
    io.files.delete("Late.md");
    await vault.notifyExternal("delete", "Late.md");
    expect(vault.getFileByPath("Late.md")).toBeNull();
  });

  it("adapter reads and writes any path, including the hidden config dir", async () => {
    const { vault } = await makeVault();
    expect(await vault.adapter.exists(".obsidian/app.json")).toBe(true);
    await vault.adapter.write(".obsidian/plugins/x/data.json", "{}");
    expect(await vault.adapter.read(".obsidian/plugins/x/data.json")).toBe("{}");
    expect(await vault.adapter.list("Projects")).toEqual({
      files: ["Projects/Plan.md", "Projects/notes.txt"],
      folders: [],
    });
    expect(vault.adapter.getBasePath()).toBe("/vault");
    expect(vault.adapter.getFullPath("a/b.md")).toBe("/vault/a/b.md");
    await expect(vault.adapter.readBinary("Home.md")).rejects.toThrow(/not supported/);
  });

  it("MetadataCache indexes, resolves links and fires changed/resolved", async () => {
    const { vault, io } = await makeVault();
    const cache = new MetadataCache(vault);
    const changed: string[] = [];
    const resolved = vi.fn();
    cache.on("changed", (f: TFile) => void changed.push(f.path));
    cache.on("resolved", resolved);
    cache.start();
    await cache.indexAll();
    expect(changed.sort()).toEqual(["Home.md", "Projects/Plan.md"]);
    expect(resolved).toHaveBeenCalled();
    expect(cache.resolvedLinks["Home.md"]).toEqual({ "Projects/Plan.md": 1 });
    expect(cache.unresolvedLinks["Home.md"]).toEqual({ Missing: 1 });
    expect(cache.resolvedLinks["Projects/Plan.md"]).toEqual({ "Home.md": 1 });
    expect(cache.getFileCache(vault.getFileByPath("Projects/Plan.md")!)?.frontmatter).toEqual({
      tags: "plan",
    });
    expect(cache.getTags()).toEqual({ "#plan": 1 });

    // A vault modify reindexes and re-resolves.
    const home = vault.getFileByPath("Home.md")!;
    await vault.modify(home, "# Home\n[[Missing]]");
    await vi.waitFor(() => expect(cache.resolvedLinks["Home.md"]).toEqual({}));
    expect(io.files.get("Home.md")).toBe("# Home\n[[Missing]]");

    // Creating the missing note resolves the link.
    await vault.create("Missing.md", "x");
    await vi.waitFor(() => expect(cache.resolvedLinks["Home.md"]).toEqual({ "Missing.md": 1 }));
    cache.dispose();
  });

  it("getFirstLinkpathDest prefers exact paths, then the nearest same-named note", async () => {
    const io = createMemoryVaultIo({ "x.md": "", "a/x.md": "", "a/b/x.md": "", "z/y.md": "" });
    const vault = new Vault(io);
    await vault.load();
    const cache = new MetadataCache(vault);
    expect(cache.getFirstLinkpathDest("a/x", "z/y.md")?.path).toBe("a/x.md");
    expect(cache.getFirstLinkpathDest("x", "a/b/c.md")?.path).toBe("x.md"); // shortest path wins
    expect(cache.getFirstLinkpathDest("b/x", "z/y.md")?.path).toBe("a/b/x.md");
    expect(cache.getFirstLinkpathDest("nope", "z/y.md")).toBeNull();
    expect(cache.getFirstLinkpathDest("", "z/y.md")?.path).toBe("z/y.md");
  });

  it("getFirstLinkpathDest matches decomposed (NFD) file names with precomposed (NFC) links and back", async () => {
    const nfd = "Fran\u0063\u0327ois Lamarre"; // macOS-style: c + combining cedilla
    const nfc = "Fran\u00e7ois Lamarre";
    expect(nfd).not.toBe(nfc);
    for (const [onDisk, link] of [
      [nfd, nfc],
      [nfc, nfd],
    ]) {
      const io = createMemoryVaultIo({ [`Boss/${onDisk}.md`]: "", "z/y.md": "" });
      const vault = new Vault(io);
      await vault.load();
      const cache = new MetadataCache(vault);
      expect(cache.getFirstLinkpathDest(link, "z/y.md")?.path).toBe(`Boss/${onDisk}.md`);
      expect(cache.getFirstLinkpathDest(`Boss/${link}`, "z/y.md")?.path).toBe(`Boss/${onDisk}.md`);
    }
  });

  it("getFirstLinkpathDest ties break like the Rust resolver: nearest folder, shortest, alphabetical", async () => {
    const io = createMemoryVaultIo({ "a/n.md": "", "b/n.md": "", "b/s/n.md": "" });
    const vault = new Vault(io);
    await vault.load();
    const cache = new MetadataCache(vault);
    expect(cache.getFirstLinkpathDest("n", "b/s/deep/src.md")?.path).toBe("b/s/n.md");
    expect(cache.getFirstLinkpathDest("n", "b/src.md")?.path).toBe("b/n.md");
    expect(cache.getFirstLinkpathDest("N", "z/src.md")?.path).toBe("a/n.md");
  });
});

describe("Editor facade", () => {
  function backend(initial: string) {
    let text = initial;
    let sel = [{ anchor: 0, head: 0 }];
    const b: EditorBackend = {
      getValue: () => text,
      replaceRange: (from, to, ins) => void (text = text.slice(0, from) + ins + text.slice(to)),
      getSelections: () => sel,
      setSelections: (r) => void (sel = r),
      focus: () => {},
    };
    return { b, text: () => text };
  }

  it("converts between offsets and line/ch and edits ranges", () => {
    const { b, text } = backend("one\ntwo\nthree");
    const ed = new Editor(b);
    expect(ed.lineCount()).toBe(3);
    expect(ed.getLine(1)).toBe("two");
    expect(ed.posToOffset({ line: 2, ch: 2 })).toBe(10);
    expect(ed.offsetToPos(10)).toEqual({ line: 2, ch: 2 });
    ed.replaceRange("TWO", { line: 1, ch: 0 }, { line: 1, ch: 3 });
    expect(text()).toBe("one\nTWO\nthree");
    ed.setLine(0, "uno");
    expect(ed.getValue()).toBe("uno\nTWO\nthree");
    ed.setSelection({ line: 0, ch: 0 }, { line: 0, ch: 3 });
    expect(ed.getSelection()).toBe("uno");
    expect(ed.somethingSelected()).toBe(true);
    ed.replaceSelection("x");
    expect(ed.getValue()).toBe("x\nTWO\nthree");
    ed.setCursor({ line: 1, ch: 1 });
    expect(ed.getCursor()).toEqual({ line: 1, ch: 1 });
  });
});

describe("functions", () => {
  it("debounce coalesces calls, supports cancel and run", () => {
    vi.useFakeTimers();
    try {
      const cb = vi.fn();
      const d = debounce(cb, 100);
      d(1);
      d(2);
      vi.advanceTimersByTime(99);
      expect(cb).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith(2);
      d(3);
      d.cancel();
      vi.advanceTimersByTime(500);
      expect(cb).toHaveBeenCalledTimes(1);
      d(4);
      d.run();
      expect(cb).toHaveBeenLastCalledWith(4);
      // resetTimer restarts the wait
      const r = debounce(cb, 100, true);
      r(5);
      vi.advanceTimersByTime(80);
      r(6);
      vi.advanceTimersByTime(80);
      expect(cb).not.toHaveBeenCalledWith(6);
      vi.advanceTimersByTime(20);
      expect(cb).toHaveBeenLastCalledWith(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it("yaml round trip", () => {
    const value = { a: 1, list: ["x", "y"], nested: { ok: true } };
    expect(parseYaml(stringifyYaml(value))).toEqual(value);
  });

  it("frontmatter tag and alias helpers", () => {
    expect(parseFrontMatterTags({ tags: "a, #b" })).toEqual(["#a", "#b"]);
    expect(parseFrontMatterTags({ Tag: ["c"] })).toEqual(["#c"]);
    expect(parseFrontMatterTags({})).toBeNull();
    expect(parseFrontMatterAliases({ aliases: ["x", "y"] })).toEqual(["x", "y"]);
  });

  it("requireApiVersion compares semver triples", () => {
    expect(requireApiVersion("0.15.0")).toBe(true);
    expect(requireApiVersion("99.0.0")).toBe(false);
  });

  it("fuzzy search matches subsequences and reports ranges", () => {
    const search = prepareFuzzySearch("abc");
    expect(search("xaxbxc")?.matches).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
    ]);
    expect(search("abxc")?.matches).toEqual([
      [0, 2],
      [3, 4],
    ]);
    expect(search("acb")).toBeNull();
  });

  it("moment is the real library", () => {
    const m = moment(new Date(2026, 0, 5, 7, 8, 9));
    expect(m.format("YYYY-MM-DD HH:mm:ss [at] x")).toMatch(/^2026-01-05 07:08:09 at \d+$/);
    expect(m.startOf("day").format("HH:mm")).toBe("00:00");
    expect(m.add(1, "week").format("MM-DD")).toBe("01-12");
  });
});

describe("path shim", () => {
  it("matches posix path semantics for the common functions", () => {
    expect(pathShim.join("a", "b", "..", "c.md")).toBe("a/c.md");
    expect(pathShim.basename("/x/y/z.md", ".md")).toBe("z");
    expect(pathShim.dirname("/x/y/z.md")).toBe("/x/y");
    expect(pathShim.dirname("z.md")).toBe(".");
    expect(pathShim.extname("a.b.md")).toBe(".md");
    expect(pathShim.extname(".hidden")).toBe("");
    expect(pathShim.normalize("a//b/./c/../d")).toBe("a/b/d");
    expect(pathShim.relative("/a/b", "/a/c/d")).toBe("../c/d");
    expect(pathShim.isAbsolute("/a")).toBe(true);
    expect(pathShim.resolve("/a", "b", "../c")).toBe("/a/c");
    expect(pathShim.parse("/x/y.md")).toEqual({
      root: "/",
      dir: "/x",
      base: "y.md",
      ext: ".md",
      name: "y",
    });
  });
});
