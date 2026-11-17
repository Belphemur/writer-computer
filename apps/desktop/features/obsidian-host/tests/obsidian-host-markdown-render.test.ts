// @vitest-environment jsdom
// MarkdownRenderer.render: Obsidian syntax, link routing, sanitizing, re-render hygiene.
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const opened = vi.hoisted(() => [] as string[]);
vi.mock("../web/host/node/external-links", () => ({
  openExternalUrl: (u: string) => {
    opened.push(u);
    return true;
  },
}));

import { createApp, type App } from "../web/host/api/app";
import { Component, createHostServices } from "../web/host/api/core";
import { MarkdownRenderer } from "../web/host/api/markdown";
import { setMarkdownRenderer } from "../web/host/api/functions";
import {
  createMarkdownRenderer,
  extractSection,
  markdownToSafeHtml,
} from "../web/host/api/markdown-render";
import { detachedBridge } from "../web/host/api/views";
import { createMemoryVaultIo } from "../web/host/testing";

interface Rig {
  app: App;
  tabs: { path: string; newLeaf: boolean }[];
  render: (md: string, el?: HTMLElement, source?: string, c?: Component) => Promise<HTMLElement>;
}

async function makeRig(files: Record<string, string>): Promise<Rig> {
  const tabs: Rig["tabs"] = [];
  const app = createApp({
    io: createMemoryVaultIo(files),
    services: createHostServices({ read: async () => null, write: async () => {} }),
    bridge: {
      ...detachedBridge,
      openFile: async (path, opts) => void tabs.push({ path, ...opts }),
    },
  });
  await app.vault.load();
  setMarkdownRenderer(
    createMarkdownRenderer({ app, resourceUrl: (_a, f) => `asset://localhost/${f.path}` }),
  );
  const render: Rig["render"] = async (md, el = document.createElement("div"), source = "", c) => {
    document.body.append(el);
    await MarkdownRenderer.render(app, md, el, source, c ?? new Component());
    return el;
  };
  return { app, tabs, render };
}

const click = (el: Element, init: MouseEventInit = {}) =>
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));

describe("markdown render: syntax", () => {
  let rig: Rig;
  beforeEach(async () => {
    opened.length = 0;
    rig = await makeRig({
      "Note.md": "note body",
      "dir/Other.md": "other",
      "img/pic.png": "png",
    });
  });

  it("wiki link variants resolve and unresolved ones are flagged", async () => {
    const el = await rig.render(
      "[[Note]] [[Note|alias]] [[Note#Heading]] [[Other]] [[Missing]] [[#Local]]",
      undefined,
      "Note.md",
    );
    const links = [...el.querySelectorAll<HTMLAnchorElement>("a.internal-link")];
    expect(links.map((a) => a.textContent)).toEqual([
      "Note",
      "alias",
      "Note#Heading",
      "Other",
      "Missing",
      "Local",
    ]);
    expect(links.map((a) => a.getAttribute("data-href"))).toEqual([
      "Note",
      "Note",
      "Note#Heading",
      "Other",
      "Missing",
      "#Local",
    ]);
    expect(links[0].getAttribute("href")).toBe("Note");
    expect(links.map((a) => a.classList.contains("is-unresolved"))).toEqual([
      false,
      false,
      false,
      false,
      true,
      false,
    ]);
    expect(el.classList.contains("markdown-rendered")).toBe(true);
  });

  it("relative markdown links become internal links", async () => {
    const el = await rig.render("[go](dir/Other.md) [sp](Note%20x.md)");
    const [a, b] = [...el.querySelectorAll("a.internal-link")];
    expect(a.getAttribute("data-href")).toBe("dir/Other.md");
    expect(b.getAttribute("data-href")).toBe("Note x.md");
    expect(b.classList.contains("is-unresolved")).toBe(true);
  });

  it("code, fences, lists, headings, tables, emphasis and task lists", async () => {
    const el = await rig.render(
      [
        "# Title",
        "Use `[[not a link]]` and **bold** *it*.",
        "```ts\nconst a = [[1]];\n```",
        "- [x] done\n- [ ] todo",
        "| a | b |\n|---|---|\n| 1 | 2 |",
      ].join("\n\n"),
    );
    expect(el.querySelector("h1")?.textContent).toBe("Title");
    expect(el.querySelector("p code")?.textContent).toBe("[[not a link]]");
    expect(el.querySelector("pre > code.language-ts")?.textContent).toContain("[[1]]");
    expect(el.querySelectorAll("a.internal-link")).toHaveLength(0);
    expect(el.querySelector("strong")?.textContent).toBe("bold");
    const boxes = el.querySelectorAll<HTMLInputElement>("input[type=checkbox]");
    expect(boxes).toHaveLength(2);
    expect(boxes[0].checked && boxes[0].disabled).toBe(true);
    expect(boxes[1].checked).toBe(false);
    expect(el.querySelectorAll("table td")).toHaveLength(2);
  });

  it("callouts, highlight, comments, tags, math, frontmatter", async () => {
    const el = await rig.render(
      [
        "---\ntitle: x\n---",
        "> [!warning] Careful\n> be **careful**",
        "==marked== %%hidden%% visible #project/a and #123 and C#",
        "Price $5 and $10, math $x^2$ and\n\n$$a<b$$",
      ].join("\n"),
    );
    const callout = el.querySelector("div.callout[data-callout=warning]");
    expect(callout?.querySelector(".callout-title-inner")?.textContent).toBe("Careful");
    expect(callout?.querySelector(".callout-content strong")?.textContent).toBe("careful");
    expect(el.querySelector("mark")?.textContent).toBe("marked");
    expect(el.textContent).not.toContain("hidden");
    expect(el.textContent).not.toContain("title: x");
    expect([...el.querySelectorAll("a.tag")].map((a) => a.getAttribute("href"))).toEqual([
      "#project/a",
    ]);
    expect([...el.querySelectorAll(".math")].map((m) => m.textContent)).toEqual(["x^2", "a<b"]);
    expect(el.textContent).toContain("$5 and $10");
  });

  it("callout without title uses the capitalised type", async () => {
    const el = await rig.render("> [!note]\n> body");
    expect(el.querySelector(".callout-title-inner")?.textContent).toBe("Note");
    expect(el.querySelector(".callout-content")?.textContent).toContain("body");
  });

  it("image embeds resolve through the vault; sizes are honoured", async () => {
    const el = await rig.render("![[pic.png]] ![[pic.png|120]] ![[nope.png]]");
    const imgs = el.querySelectorAll("img");
    expect(imgs[0].getAttribute("src")).toBe("asset://localhost/img/pic.png");
    expect(imgs[1].getAttribute("width")).toBe("120");
    expect(el.querySelectorAll(".is-unresolved")).toHaveLength(1);
  });

  it("a base embed becomes an open-base link that opens a new tab", async () => {
    const r = await makeRig({ "tasks.base": "views: []", "Note.md": "x" });
    const el = await r.render("![[tasks.base#Board]]", undefined, "Note.md");
    const link = el.querySelector<HTMLAnchorElement>("a.internal-link")!;
    expect(link.textContent).toBe("Open base: tasks.base (Board)");
    expect(el.querySelector(".is-unresolved")).toBeNull();
    click(link);
    await new Promise((r2) => setTimeout(r2, 0));
    expect(r.tabs.map((t) => t.path)).toEqual(["tasks.base"]);
    expect(r.tabs[0]!.newLeaf).toBe(true);
  });

  it("note and heading embeds render inline", async () => {
    const r = await makeRig({
      "A.md": "---\nx: 1\n---\nintro\n# One\nfirst [[B]]\n## Sub\nsub text\n# Two\nsecond",
      "B.md": "bee",
    });
    const el = await r.render("![[A#One]]", undefined, "main.md");
    const text = el.querySelector(".markdown-embed-content")?.textContent ?? "";
    expect(text).toContain("first");
    expect(text).toContain("sub text");
    expect(text).not.toContain("second");
    expect(text).not.toContain("intro");
    expect(extractSection("# A\nx\n# B\ny", "b")).toBe("# B\ny");
    expect(extractSection("# A", "zzz")).toBeNull();
  });

  it("embed cycles and depth are cut", async () => {
    const r = await makeRig({
      "A.md": "a ![[B]]",
      "B.md": "b ![[A]]",
      "D1.md": "1 ![[D2]]",
      "D2.md": "2 ![[D3]]",
      "D3.md": "3 ![[D4]]",
      "D4.md": "4 ![[D5]]",
      "D5.md": "five",
    });
    const cyc = await r.render("![[A]]", undefined, "root.md");
    expect(cyc.querySelectorAll(".markdown-embed")).toHaveLength(2);
    expect(cyc.querySelector(".is-unresolved")?.textContent).toBe("A");
    const deep = await r.render("![[D1]]", undefined, "root.md");
    expect(deep.querySelectorAll(".markdown-embed")).toHaveLength(3);
    expect(deep.textContent).not.toContain("five");
    // Self-embed from the rendering note itself.
    const self = await r.render("![[A]]", undefined, "A.md");
    expect(self.querySelector(".markdown-embed")).toBeNull();
  });
});

describe("markdown render: clicks", () => {
  let rig: Rig;
  beforeEach(async () => {
    opened.length = 0;
    rig = await makeRig({ "Note.md": "n", "dir/Other.md": "o" });
  });

  it("internal links open a new tab, whatever the modifier", async () => {
    const el = await rig.render("[[Note]] [[dir/Other#H]]", undefined, "x.md");
    const [a, b] = [...el.querySelectorAll("a")];
    expect(click(a)).toBe(false); // default prevented: the webview never navigates
    click(b, { ctrlKey: true });
    click(a, { metaKey: true });
    b.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }));
    await Promise.resolve();
    await Promise.resolve();
    expect(rig.tabs).toEqual([
      { path: "Note.md", newLeaf: true },
      { path: "dir/Other.md", newLeaf: true },
      { path: "Note.md", newLeaf: true },
      { path: "dir/Other.md", newLeaf: true },
    ]);
  });

  it("an unresolved link shows a notice instead of throwing", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const el = await rig.render("[[Missing]]");
    click(el.querySelector("a")!);
    await new Promise((r) => setTimeout(r, 0));
    expect(rig.tabs).toHaveLength(0);
    expect(document.body.textContent).toContain('Cannot open "Missing"');
    err.mockRestore();
  });

  it("external links use the open helper, never navigate", async () => {
    const el = await rig.render("[x](https://example.com/a?b=1) <https://example.org> #tag");
    const anchors = [...el.querySelectorAll("a")];
    expect(click(anchors[0])).toBe(false);
    click(anchors[1]);
    expect(opened).toEqual(["https://example.com/a?b=1", "https://example.org"]);
    expect(click(el.querySelector("a.tag")!)).toBe(false);
    expect(rig.tabs).toHaveLength(0);
  });
});

describe("markdown render: sanitizing", () => {
  const payloads = [
    '<img src=x onerror="alert(1)">',
    "[x](javascript:alert(1))",
    "[x](JaVa\tScRiPt:alert(1))",
    "<script>alert(1)</script>",
    '<a href="javascript:alert(1)" onclick="x()">y</a>',
    '<iframe src="https://evil"></iframe><style>*{}</style><svg onload=x></svg>',
    '<a class="internal-link" href="javascript:alert(1)" data-href="x">z</a>',
    "![x](javascript:alert(1)) ![y](data:text/html;base64,AAAA) ![z](data:image/svg+xml;base64,AAAA)",
    '<div id="app" name="x" style="position:fixed" class="evil">d</div>',
    '<input type="text" value="x"><form action="https://evil"><button>b</button></form>',
  ];

  it.each(payloads)("neutralises %s", (payload) => {
    const html = markdownToSafeHtml(payload);
    const d = document.createElement("div");
    d.innerHTML = html;
    expect(d.querySelector("script, iframe, style, svg, form, button, object, embed")).toBeNull();
    for (const el of d.querySelectorAll("*")) {
      for (const attr of el.getAttributeNames()) {
        expect(attr.startsWith("on")).toBe(false);
        expect(["id", "name", "style"]).not.toContain(attr);
      }
      expect(el.getAttribute("href") ?? "").not.toMatch(/^\s*javascript:/i);
      expect(el.getAttribute("src") ?? "").not.toMatch(/^(?:javascript|data:(?!image\/png))/i);
    }
    expect(d.querySelector("input:not([type=checkbox])")).toBeNull();
    expect(d.querySelector(".evil")).toBeNull();
  });

  it("allows https images and raster data images", () => {
    const html = markdownToSafeHtml(
      "![a](https://example.com/a.png) ![b](data:image/png;base64,AAAA)",
    );
    expect(html).toContain('src="https://example.com/a.png"');
    expect(html).toContain('src="data:image/png;base64,AAAA"');
  });
});

describe("markdown render: re-render", () => {
  it("is idempotent, replaces content and keeps one listener set", async () => {
    const rig = await makeRig({ "Note.md": "n" });
    const el = document.createElement("div");
    const comp = new Component();
    comp.load();
    const add = vi.spyOn(el, "addEventListener");
    const remove = vi.spyOn(el, "removeEventListener");
    for (let i = 0; i < 20; i++) await rig.render(`msg [[Note]] ${"x".repeat(i)}`, el, "", comp);
    await rig.render("msg [[Note]]", el, "", comp);
    const once = el.innerHTML;
    await rig.render("msg [[Note]]", el, "", comp);
    expect(el.innerHTML).toBe(once);
    expect(el.querySelectorAll("p")).toHaveLength(1);
    expect(el.querySelectorAll("a")).toHaveLength(1);
    expect(add).toHaveBeenCalledTimes(2); // click + auxclick, once
    click(el.querySelector("a")!);
    await Promise.resolve();
    await Promise.resolve();
    expect(rig.tabs).toHaveLength(1);
    comp.unload();
    expect(remove).toHaveBeenCalledTimes(2);
    click(el.querySelector("a")!);
    await Promise.resolve();
    expect(rig.tabs).toHaveLength(1);
  });

  it("a stale embed render never lands after a newer one", async () => {
    const rig = await makeRig({ "A.md": "alpha", "B.md": "beta" });
    const el = document.createElement("div");
    const first = rig.render("![[A]]", el);
    const second = rig.render("![[B]]", el);
    await Promise.all([first, second]);
    expect(el.textContent).toContain("beta");
    expect(el.textContent).not.toContain("alpha");
  });

  it("the deprecated renderMarkdown works without an app argument", async () => {
    const rig = await makeRig({ "Note.md": "n" });
    const el = document.createElement("div");
    await MarkdownRenderer.renderMarkdown("[[Note]]", el, "", new Component());
    expect(el.querySelector("a.internal-link")).not.toBeNull();
    void rig;
  });
});

describe("markdown render: paragraphs and line breaks", () => {
  const dom = (md: string): HTMLElement => {
    const d = document.createElement("div");
    d.innerHTML = markdownToSafeHtml(md);
    return d;
  };

  it("splits blank-line separated paragraphs and keeps block order", () => {
    const d = dom(
      "# H\npara one\n\npara two\nsecond line\n\n- a\n- b\n\n```\ncode\n```\nafter code\n\n> quote [[Note]]\n\nhard  \nbreak and back\\\nslash",
    );
    expect([...d.children].map((c) => c.tagName)).toEqual([
      "H1",
      "P",
      "P",
      "UL",
      "PRE",
      "P",
      "BLOCKQUOTE",
      "P",
    ]);
    // A single newline is a visible break (Obsidian default), not a space.
    expect(d.children[2].innerHTML).toBe("para two<br>second line");
    expect(d.children[7].querySelectorAll("br")).toHaveLength(2);
    expect(d.querySelector("blockquote a.internal-link")?.getAttribute("data-href")).toBe("Note");
  });

  it("styles .markdown-rendered paragraphs, lists and headings against the preflight reset", async () => {
    const { OBSIDIAN_THEME_CSS } = await import("../web/host/api/theme-compat");
    expect(OBSIDIAN_THEME_CSS).toMatch(/\.markdown-rendered p \{ margin: 0 0 var\(--p-spacing\)/);
    expect(OBSIDIAN_THEME_CSS).toMatch(/\.markdown-rendered ul \{ list-style: disc/);
    expect(OBSIDIAN_THEME_CSS).toMatch(/\.markdown-rendered \{[^}]*white-space: normal/);
  });
});
