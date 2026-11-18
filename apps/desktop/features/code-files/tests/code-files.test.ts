// Code and text files in the vault: extension routing, language resolution, highlighting, the
// code editor's configuration, tab titles, mentions, the store's raw load, tree icons and the
// plugin vault's dot-folder rule. Tauri is faked; every file is synthetic.
// Spec: SPECs/code-files-spec.md.
// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { highlightTree, classHighlighter } from "@lezer/highlight";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));

import { invoke } from "@tauri-apps/api/core";
import fragment from "../settings.schema.json";
import { agentSkillDir, codeIconFamily, isAgentFolderPath, isCodePath } from "@/lib/code-files";
import {
  CODE_MAX_BYTES,
  CODE_READ_ONLY_BYTES,
  codeLanguageFor,
  defaultIndentFor,
  detectIndent,
  isOverReadOnlyLimit,
} from "../web/lib/code-language";
import { DEFAULT_CODE_EXTENSIONS, isSecretName } from "../web/rules";
import codeFiles from "../web";
import { createFeatureHost } from "@/lib/features/registry";
import { useSettingsStore } from "@/stores/settings-store";
import {
  deserializeLocation,
  locationForPath,
  opensAsDocument,
  pageKind,
  serializeLocation,
} from "@/components/editor-area/page-kinds";
import { noteLabel } from "@/lib/note-title";
import { candidatesFromResults } from "@features/agent/web/lib/mentions";
import { useEditorStore } from "@/stores/editor-store";
import { flattenTree } from "@/components/sidebar/flatten-tree";
import { FileIcon } from "@/components/sidebar/file-tree-icons";
import { managedSkillDirFor } from "@/lib/managed-skills";
import {
  createCodeEditorCompartments,
  createCodeEditorExtensions,
  loadLanguageExtension,
} from "../web/components/code-editor-extensions";
import { createTauriVaultIo } from "@features/obsidian-host/web/host/api/vault-io-tauri";
import type { DirEntry } from "@/types/fs";

const mockedInvoke = vi.mocked(invoke);

// Core finds the rules through the `code-files.rules` service, so the feature is registered for
// every test (the off behaviour is in code-files-feature.test.tsx).
const host = createFeatureHost({ onError: () => {} });
const configureCodeFiles = (list: unknown) =>
  useSettingsStore.setState({
    settings: list === undefined ? {} : { "code-files.extensions": list },
  });
beforeEach(() => {
  configureCodeFiles(undefined);
  host.register(codeFiles);
});
afterEach(async () => {
  for (const id of host.list()) await host.unregister(id);
  configureCodeFiles(undefined);
});

describe("which paths open as code", () => {
  it("claims the default extensions and the Dockerfile/Makefile names", () => {
    for (const p of [
      "/v/a.py",
      "/v/a.TS",
      "/v/x.tsx",
      "/v/m.rs",
      "/v/go/main.go",
      "/v/cfg.json",
      "/v/Dockerfile",
      "/v/Makefile",
      "/v/run.sh",
      "/v/notes.txt",
      "/v/.agents/skills/x/run.py",
    ]) {
      expect(isCodePath(p), p).toBe(true);
    }
  });

  it("leaves notes, bases, images, svg, ipynb, unknown files and secrets alone", () => {
    for (const p of [
      "/v/a.md",
      "/v/a.base",
      "/v/a.png",
      "/v/a.svg",
      "/v/a.ipynb",
      "/v/a.pdf",
      "/v/noext",
      "/v/.env",
      "/v/.env.local",
      "/v/prod.env",
      "/v/a.pem",
      "/v/id_rsa",
      "/v/secrets.yaml",
      "/v/aws-credentials.json",
    ]) {
      expect(isCodePath(p), p).toBe(false);
    }
    expect(isSecretName(".env")).toBe(true);
  });

  it("follows code-files.extensions and never lets a setting enable secrets", () => {
    configureCodeFiles([".PY", "rs", "env", "pem", "md"]);
    expect(isCodePath("/v/a.py")).toBe(true);
    expect(isCodePath("/v/a.rs")).toBe(true);
    expect(isCodePath("/v/a.ts")).toBe(false);
    expect(isCodePath("/v/prod.env")).toBe(false);
    expect(isCodePath("/v/a.pem")).toBe(false);
    expect(isCodePath("/v/a.md")).toBe(false);
  });

  it("takes its defaults from the schema and the shared file", () => {
    expect(DEFAULT_CODE_EXTENSIONS).toEqual(
      fragment.settings.find((s) => s.key === "code-files.extensions")!.default,
    );
    const ignored = fragment.settings.find((s) => s.key === "code-files.ignored-folders")!;
    expect(ignored.default).toEqual(
      expect.arrayContaining(["node_modules", "target", "dist", "build", ".venv", "__pycache__"]),
    );
    expect(fragment.settings.find((s) => s.key === "code-files.show-agent-folders")!.default).toBe(
      true,
    );
    expect(fragment.settings.find((s) => s.key === "code-files.word-wrap")!.default).toBe(false);
    expect(CODE_MAX_BYTES).toBe(20 * 1024 * 1024);
    expect(CODE_READ_ONLY_BYTES).toBe(2 * 1024 * 1024);
    expect(isOverReadOnlyLimit("x".repeat(CODE_READ_ONLY_BYTES))).toBe(false);
    expect(isOverReadOnlyLimit("x".repeat(CODE_READ_ONLY_BYTES + 1))).toBe(true);
  });
});

describe("page kind and titles", () => {
  it("routes code paths to the code kind and everything else as before", () => {
    expect(locationForPath("/v/a.py")).toEqual({ kind: "code", path: "/v/a.py" });
    expect(locationForPath("/v/a.md").kind).toBe("file");
    expect(locationForPath("/v/a.base").kind).toBe("base");
    expect(opensAsDocument("/v/a.py")).toBe(true);
  });

  it("titles a code tab with its file name and extension", () => {
    const location = locationForPath("/v/tools/run.py");
    expect(pageKind(location).title(location)).toBe("run.py");
    expect(noteLabel("/v/tools/run.py").text).toBe("run.py");
    expect(noteLabel("/v/Dockerfile").text).toBe("Dockerfile");
    // a frontmatter title never overrides a code file's name
    expect(noteLabel("/v/run.py", "Nope").text).toBe("run.py");
    expect(noteLabel("/v/Note.md").text).toBe("Note");
  });

  it("round-trips through the session and follows renames and deletes", () => {
    const location = locationForPath("/v/a.py");
    const k = pageKind(location);
    expect(deserializeLocation(serializeLocation(location))).toEqual(location);
    expect(k.rewritePath(location, "/v/a.py", "/v/b.py")).toEqual({
      kind: "code",
      path: "/v/b.py",
    });
    expect(k.removePath(location, "/v/a.py")).toBeNull();
  });
});

describe("language and highlighting", () => {
  it("resolves a language for the common extensions", () => {
    const expected: Record<string, string> = {
      "a.py": "Python",
      "a.ts": "TypeScript",
      "a.tsx": "TSX",
      "a.js": "JavaScript",
      "a.jsx": "JSX",
      "a.mjs": "JavaScript",
      "a.json": "JSON",
      "a.jsonc": "JSON",
      "a.yaml": "YAML",
      "a.yml": "YAML",
      "a.toml": "TOML",
      "a.rs": "Rust",
      "a.go": "Go",
      "a.java": "Java",
      "a.kt": "Kotlin",
      "a.swift": "Swift",
      "a.c": "C",
      "a.cpp": "C++",
      "a.cs": "C#",
      "a.rb": "Ruby",
      "a.php": "PHP",
      "a.sh": "Shell",
      "a.sql": "SQL",
      "a.css": "CSS",
      "a.scss": "SCSS",
      "a.html": "HTML",
      "a.xml": "XML",
      "a.lua": "Lua",
      "a.r": "R",
      "a.scala": "Scala",
      "a.dart": "Dart",
      "a.pyi": "Python",
      "a.zsh": "Shell",
      "a.dockerfile": "Dockerfile",
      Dockerfile: "Dockerfile",
    };
    for (const [file, name] of Object.entries(expected)) {
      expect(codeLanguageFor(file)?.name, file).toBe(name);
    }
    expect(codeLanguageFor("notes.txt")).toBeNull();
    expect(codeLanguageFor("data.csv")).toBeNull();
    // no language in the shared data: opens as plain text
    for (const f of ["Makefile", "a.mk", "a.tf", "a.ex", "a.bat"]) {
      expect(codeLanguageFor(f), f).toBeNull();
    }
  });

  const fixtures: Record<string, string> = {
    "a.py": "def add(a, b):\n    return a + 1  # sum\n\nclass A:\n    s = 'x'\n",
    "a.ts": "export const n: number = 1;\nfunction f(x: string) { return `a${x}`; }\n",
    "a.rs": 'fn main() {\n    let s = "hi"; // c\n    println!("{}", s);\n}\n',
    "a.json": '{"a": [1, true, null], "b": "x"}\n',
  };

  for (const [file, text] of Object.entries(fixtures)) {
    it(`produces highlight tokens for ${file}`, async () => {
      const support = await codeLanguageFor(file)!.load();
      const tree = support.language.parser.parse(text);
      const classes = new Set<string>();
      highlightTree(tree, classHighlighter, (_from, _to, cls) => classes.add(cls));
      expect(classes.size).toBeGreaterThanOrEqual(3);
    });
  }
});

describe("indentation", () => {
  it("defaults by language: tabs for Go and Makefiles, 2 spaces for web, 4 otherwise", () => {
    expect(defaultIndentFor("main.go").tabs).toBe(true);
    expect(defaultIndentFor("Makefile").tabs).toBe(true);
    expect(defaultIndentFor("a.ts")).toEqual({ unit: "  ", tabs: false, size: 2 });
    expect(defaultIndentFor("a.yaml").size).toBe(2);
    expect(defaultIndentFor("a.py")).toEqual({ unit: "    ", tabs: false, size: 4 });
    expect(defaultIndentFor("a.rs").size).toBe(4);
  });

  it("detects what the file already uses", () => {
    const fallback = defaultIndentFor("a.py");
    expect(detectIndent("if x:\n  a()\n  if y:\n    b()\n", fallback)).toMatchObject({
      tabs: false,
      size: 2,
    });
    expect(detectIndent("if x:\n\ta()\n\tb()\n", fallback).tabs).toBe(true);
    expect(detectIndent("x = 1\ny = 2\n", fallback)).toEqual(fallback);
  });
});

describe("the code editor configuration", () => {
  function mount(text: string, file: string, readOnly = false) {
    const compartments = createCodeEditorCompartments();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: text,
        extensions: createCodeEditorExtensions({
          getFilePath: () => `/v/${file}`,
          isDisposed: () => false,
          compartments,
          indent: defaultIndentFor(file),
          wrap: false,
          readOnly,
        }),
      }),
    });
    return { view, host, compartments };
  }

  it("has line numbers, a fold gutter and an active line, and none of the markdown preview", () => {
    const { view, host } = mount("# not a heading\n**not bold** [[not a link]]\n", "a.txt");
    expect(host.querySelector(".cm-lineNumbers")).not.toBeNull();
    expect(host.querySelector(".cm-foldGutter")).not.toBeNull();
    expect(host.querySelector(".cm-activeLine")).not.toBeNull();
    const html = host.innerHTML;
    // markdown decorations hide marks and wrap headings, links and emphasis in classes/widgets
    for (const cls of ["cm-heading", "cm-hide", "cm-wiki-link", "cm-md-", "cm-fenced-code"]) {
      expect(html, cls).not.toContain(cls);
    }
    expect(view.state.doc.toString()).toContain("**not bold**");
    view.destroy();
  });

  it("applies the language through its compartment and keeps text editable unless read-only", async () => {
    const { view, host, compartments } = mount("def f():\n    return 1\n", "a.py");
    view.dispatch({
      effects: compartments.language.reconfigure(
        await loadLanguageExtension(codeLanguageFor("a.py")),
      ),
    });
    expect(view.state.readOnly).toBe(false);
    expect(host.querySelectorAll(".cm-line span").length).toBeGreaterThan(0);
    view.destroy();
    const ro = mount("x", "a.py", true);
    expect(ro.view.state.readOnly).toBe(true);
    ro.view.destroy();
  });
});

describe("mentions, tree and icons", () => {
  it("lists code files in @-mentions with their extension", () => {
    const out = candidatesFromResults("run", [
      { relative_path: "tools/run.py" },
      { relative_path: "notes/Run.md" },
      { relative_path: ".agents/skills/x/run.sh" },
    ]);
    const notes = out.filter((c) => c.kind === "note").map((c) => c.label);
    expect(notes).toEqual(["run.py", "Run", "run.sh"]);
  });

  it("keeps code files in the tree, sorted by file name with extension", () => {
    const entry = (name: string, is_dir = false): DirEntry => ({
      name,
      path: `/v/${name}`,
      is_dir,
      is_markdown: !is_dir,
      modified_at: 1,
      created_at: 1,
      title: null,
    });
    const flat = flattenTree(
      [entry("b.py"), entry("a.md"), entry("Dockerfile"), entry("src", true)],
      0,
      new Map(),
      new Set(),
    );
    expect(flat.map((i) => i.entry.name)).toEqual(["src", "a.md", "b.py", "Dockerfile"]);
  });

  it("uses a glyph per language family and the document glyph for notes", () => {
    const svg = (name: string) => renderToStaticMarkup(createElement(FileIcon, { name }));
    expect(codeIconFamily("run.sh")).toBe("script");
    expect(codeIconFamily("a.json")).toBe("config");
    expect(codeIconFamily("a.py")).toBe("code");
    expect(codeIconFamily("a.csv")).toBe("table");
    expect(codeIconFamily("a.sql")).toBe("sql");
    expect(svg("a.py")).not.toBe(svg("a.md"));
    expect(svg("run.sh")).not.toBe(svg("a.py"));
    expect(svg("a.md")).toBe(renderToStaticMarkup(createElement(FileIcon, {})));
  });
});

describe("agent skill paths", () => {
  it("finds the skill folder of a file and the agent folders", () => {
    const root = "/v";
    expect(agentSkillDir("/v/.agents/skills/writer-cli/run.py", root)).toBe(
      "/v/.agents/skills/writer-cli",
    );
    expect(agentSkillDir("/v/.claude/skills/x/sub/a.sh", root)).toBe("/v/.claude/skills/x");
    expect(agentSkillDir("/v/notes/a.md", root)).toBeNull();
    expect(agentSkillDir("/v/.agents/other/a.md", root)).toBeNull();
    expect(isAgentFolderPath("/v/.agents", root)).toBe(true);
    expect(isAgentFolderPath("/v/.claude/skills", root)).toBe(true);
    expect(isAgentFolderPath("/v/.claude/skills/x", root)).toBe(false);
    const managed = ["/v/.agents/skills/writer-cli"];
    expect(managedSkillDirFor("/v/.agents/skills/writer-cli/SKILL.md", managed)).toBe(managed[0]);
    expect(managedSkillDirFor("/v/.agents/skills/mine/SKILL.md", managed)).toBeNull();
  });
});

describe("opening a code file in the store", () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
    mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "read_file") {
        const path = (args as { path: string }).path;
        return { path, content: "---\nname: x\n---\nprint(1)\n", modified_at: 1 };
      }
      return undefined;
    });
    useEditorStore.setState({
      openFiles: new Map(),
      tabs: [],
      closedTabs: [],
      activeTabId: null,
      activeFilePath: null,
    });
  });

  it("loads the whole text as the body: a leading --- is not frontmatter", async () => {
    await useEditorStore.getState().openFile("/v/cfg.yaml");
    const file = useEditorStore.getState().openFiles.get("/v/cfg.yaml")!;
    expect(file.frontmatter).toBeNull();
    expect(file.content).toBe("---\nname: x\n---\nprint(1)\n");
    expect(file.title).toBe("");
    expect(useEditorStore.getState().tabs[0]!.location.kind).toBe("code");
  });

  it("treats a note's frontmatter as before", async () => {
    await useEditorStore.getState().openFile("/v/n.md");
    expect(useEditorStore.getState().openFiles.get("/v/n.md")!.frontmatter).toBe("name: x");
  });
});

describe("the plugin vault", () => {
  it("never lists dot-folders, even the agent skills exception", async () => {
    mockedInvoke.mockReset();
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd !== "read_directory") return undefined;
      const e = (name: string, is_dir: boolean) => ({
        name,
        path: `/v/${name}`,
        is_dir,
        is_markdown: !is_dir,
        modified_at: 1,
        created_at: 1,
        title: null,
      });
      return [e(".agents", true), e(".claude", true), e("run.py", false), e("a.md", false)];
    });
    const io = createTauriVaultIo("/v", "v");
    const names = (await io.list("")).map((x) => x.name);
    expect(names).toEqual(["run.py", "a.md"]);
  });
});
