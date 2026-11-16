// @vitest-environment jsdom
// Callouts in MarkdownRenderer output: documented DOM, sanitizer retention, fold toggle.
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../src/lib/obsidian-host/node/external-links", () => ({ openExternalUrl: () => true }));

import { createApp } from "../src/lib/obsidian-host/api/app";
import { Component, createHostServices } from "../src/lib/obsidian-host/api/core";
import { MarkdownRenderer } from "../src/lib/obsidian-host/api/markdown";
import { setMarkdownRenderer } from "../src/lib/obsidian-host/api/functions";
import {
  createMarkdownRenderer,
  markdownToSafeHtml,
} from "../src/lib/obsidian-host/api/markdown-render";
import { detachedBridge } from "../src/lib/obsidian-host/api/views";
import { createMemoryVaultIo } from "../src/lib/obsidian-host/testing";
import { applyCustomCalloutIcons } from "../src/lib/callouts/dom";

let render: (md: string) => Promise<HTMLElement>;
beforeEach(async () => {
  const app = createApp({
    io: createMemoryVaultIo({ "img/pic.png": "png", "Note.md": "n" }),
    services: createHostServices({ read: async () => null, write: async () => {} }),
    bridge: { ...detachedBridge, openFile: async () => {} },
  });
  await app.vault.load();
  setMarkdownRenderer(
    createMarkdownRenderer({ app, resourceUrl: (_a, f) => `asset://localhost/${f.path}` }),
  );
  render = async (md) => {
    const el = document.createElement("div");
    document.body.append(el);
    await MarkdownRenderer.render(app, md, el, "", new Component());
    return el;
  };
});

describe("callout DOM", () => {
  it("documented structure, icon and title", async () => {
    const el = await render("> [!info] Heads **up**\n> body with [[Note]]");
    const c = el.querySelector<HTMLElement>("div.callout[data-callout=info]")!;
    expect(c.getAttribute("data-callout-fold")).toBe("");
    const title = c.querySelector(":scope > .callout-title")!;
    expect(title.querySelector(".callout-icon svg path")).not.toBeNull();
    expect(title.querySelector(".callout-title-inner strong")?.textContent).toBe("up");
    expect(title.querySelector(".callout-fold")).toBeNull();
    expect(c.querySelector(":scope > .callout-content a.internal-link")?.textContent).toBe("Note");
    expect(c.classList.contains("is-collapsible")).toBe(false);
  });

  it("type is case-insensitive and keeps the typed alias; unknown uses the type as title", async () => {
    const el = await render("> [!TLDR]\n> x\n\n> [!my-type]\n> y");
    const [a, b] = [...el.querySelectorAll(".callout")];
    expect(a!.getAttribute("data-callout")).toBe("tldr");
    expect(a!.querySelector(".callout-title-inner")?.textContent).toBe("Tldr");
    expect(a!.querySelector(".callout-icon")?.innerHTML).toBe(
      (await render("> [!abstract]\n> z")).querySelector(".callout-icon")!.innerHTML,
    );
    expect(b!.getAttribute("data-callout")).toBe("my-type");
    expect(b!.querySelector(".callout-title-inner")?.textContent).toBe("My-type");
  });

  it("every built-in type gets an icon", async () => {
    const md = [
      "note",
      "abstract",
      "info",
      "todo",
      "tip",
      "success",
      "question",
      "warning",
      "failure",
      "danger",
      "bug",
      "example",
      "quote",
    ]
      .map((t) => `> [!${t}]\n> x`)
      .join("\n\n");
    const el = await render(md);
    const icons = [...el.querySelectorAll(".callout-icon")];
    expect(icons).toHaveLength(13);
    expect(new Set(icons.map((i) => i.innerHTML)).size).toBe(13);
  });

  it("foldable: + open, - collapsed, with a chevron; click toggles", async () => {
    const el = await render("> [!tip]+ Open\n> a\n\n> [!faq]- Closed\n> b");
    const [open, closed] = [...el.querySelectorAll<HTMLElement>(".callout")];
    expect(open!.getAttribute("data-callout-fold")).toBe("+");
    expect(open!.classList.contains("is-collapsed")).toBe(false);
    expect(closed!.getAttribute("data-callout-fold")).toBe("-");
    expect(closed!.classList.contains("is-collapsed")).toBe(true);
    expect(closed!.querySelector(".callout-fold svg")).not.toBeNull();

    closed!.querySelector<HTMLElement>(".callout-title-inner")!.click();
    expect(closed!.classList.contains("is-collapsed")).toBe(false);
    expect(closed!.querySelector(".callout-fold")!.classList.contains("is-collapsed")).toBe(false);
    open!.querySelector<HTMLElement>(".callout-fold")!.click();
    expect(open!.classList.contains("is-collapsed")).toBe(true);
  });

  it("a non-foldable callout ignores title clicks; links in the title do not toggle", async () => {
    const el = await render("> [!note] Plain\n> a\n\n> [!note]- [[Note]]\n> b");
    const [plain, fold] = [...el.querySelectorAll<HTMLElement>(".callout")];
    plain!.querySelector<HTMLElement>(".callout-title")!.click();
    expect(plain!.className).toBe("callout");
    fold!.querySelector<HTMLElement>("a.internal-link")!.click();
    expect(fold!.classList.contains("is-collapsed")).toBe(true);
  });

  it("title-only callout has no content element", async () => {
    const el = await render("> [!warning] Only a title");
    expect(el.querySelector(".callout-content")).toBeNull();
    expect(el.querySelector(".callout-title-inner")?.textContent).toBe("Only a title");
  });

  it("nesting: nested callout and nested blockquote; markdown in the body", async () => {
    const el = await render(
      "> [!question] Outer\n> text `code`\n> - item\n> > [!todo] Inner\n> > deep\n> > > plain quote\n> ![[img/pic.png]]",
    );
    const outer = el.querySelector<HTMLElement>(".callout[data-callout=question]")!;
    const inner = outer.querySelector<HTMLElement>(".callout-content .callout[data-callout=todo]")!;
    expect(inner.querySelector(".callout-content blockquote")?.textContent).toContain(
      "plain quote",
    );
    expect(outer.querySelector(".callout-content code")?.textContent).toBe("code");
    expect(outer.querySelector(".callout-content li")?.textContent).toBe("item");
    expect(outer.querySelector("img.image-embed")?.getAttribute("src")).toContain("img/pic.png");
  });

  it("malformed headers stay blockquotes", async () => {
    const el = await render("> [!]\n> x\n\n> [!note]Title\n> y\n\n> \\[!note] z\n\n> plain");
    expect(el.querySelector(".callout")).toBeNull();
    expect(el.querySelectorAll("blockquote")).toHaveLength(4);
  });

  it("metadata attribute", async () => {
    const el = await render("> [!note|nomargin] T\n> b");
    expect(el.querySelector(".callout")?.getAttribute("data-callout-metadata")).toBe("nomargin");
  });
});

describe("sanitizer", () => {
  it("keeps the documented data attributes and classes", () => {
    const html = markdownToSafeHtml("> [!tip|m]- T\n> b");
    expect(html).toContain('data-callout="tip"');
    expect(html).toContain('data-callout-fold="-"');
    expect(html).toContain('data-callout-metadata="m"');
    expect(html).toContain("is-collapsible");
    expect(html).toContain("callout-fold");
  });

  it("drops untrusted values and unlisted classes/attributes", () => {
    const html = markdownToSafeHtml(
      '<div class="callout evil" data-callout-fold="javascript:x" onclick="x()" style="x:y" data-other="1">hi</div>',
    );
    expect(html).not.toContain("javascript");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("evil");
    expect(html).not.toContain("data-other");
    expect(html).not.toContain("style");
    expect(html).toContain("callout");
  });

  it("a title cannot inject markup", () => {
    const html = markdownToSafeHtml(
      "> [!note] <script>alert(1)</script><img src=x onerror=alert(1)>",
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror");
  });

  it("never emits svg itself (icons come from the post-pass)", () => {
    expect(markdownToSafeHtml("> [!note] T\n> <svg onload=x></svg>")).not.toContain("<svg");
  });
});

describe("custom --callout-icon", () => {
  function iconEl(type: string) {
    const host = document.createElement("div");
    host.setAttribute("data-callout", type);
    const icon = document.createElement("div");
    icon.className = "callout-icon";
    host.append(icon);
    document.body.append(host);
    return icon;
  }

  it("swaps to a built-in id and restores the default when removed", () => {
    const icon = iconEl("note");
    applyCustomCalloutIcons([[icon, "lucide-flame"]]);
    expect(icon.querySelector("svg")?.getAttribute("class")).toContain("callout-icon-tip");
    applyCustomCalloutIcons([[icon, ""]]);
    expect(icon.querySelector("svg")?.getAttribute("class")).toContain("callout-icon-note");
  });

  it("sanitises an svg string", () => {
    const icon = iconEl("note");
    applyCustomCalloutIcons([
      [
        icon,
        `'<svg viewBox="0 0 24 24" onload="x()"><script>x()</script><use href="#a"/><path d="M0 0h4"/></svg>'`,
      ],
    ]);
    const svg = icon.querySelector("svg")!;
    expect(svg.querySelector("path")?.getAttribute("d")).toBe("M0 0h4");
    expect(svg.querySelector("script, use")).toBeNull();
    expect(svg.getAttribute("onload")).toBeNull();
  });
});
