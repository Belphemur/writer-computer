// Real renderer behind MarkdownRenderer.render / renderMarkdown (installed with
// `setMarkdownRenderer`). Public Obsidian syntax only: wiki links, embeds, callouts, tags,
// ==highlight==, %%comments%%, task lists, math spans, frontmatter stripping.
//
// Pipeline: marked (context-free, module singleton) -> DOMPurify allowlist (shared core in
// lib/safe-html.ts) -> DOM post-pass that needs the vault (link resolution, tags, embeds).
// Input is untrusted (LLM output): the only way to get an element or attribute through is the
// allowlist below; the post-pass only creates elements itself.
import { convertFileSrc } from "@tauri-apps/api/core";
import { Marked, type Tokens } from "marked";
import { parseFrontmatter } from "@/lib/frontmatter";
import { SAFE_ATTR, SAFE_TAGS, sanitizeHtml } from "@/lib/safe-html";
import { openExternalUrl } from "../node/external-links";
import type { App } from "./app";
import { Notice, type Component } from "./core";
import type { MarkdownRenderContext } from "./functions";
import type { TFile } from "./vault";

/** Notes embedded inside notes inside notes... stop here. */
export const MAX_EMBED_DEPTH = 3;
const MAX_CHARS = 500_000;

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ---------------------------------------------------------------- marked

const WIKI = /^(!?)\[\[([^\]\n]+?)\]\]/;

/** Splits `target#heading|alias` (the editor's parser handles the escaped-pipe-in-table case). */
function splitWiki(inner: string): { target: string; alias: string | null } {
  const i = inner.indexOf("|");
  const target = (i < 0 ? inner : inner.slice(0, i)).replace(/\\$/, "").trim();
  return { target, alias: i < 0 ? null : inner.slice(i + 1).trim() || null };
}

const marked = new Marked({
  gfm: true,
  renderer: {
    checkbox: ({ checked }: { checked: boolean }) =>
      `<input type="checkbox" class="task-list-item-checkbox" disabled${checked ? " checked" : ""}> `,
    blockquote(this: any, { tokens }: Tokens.Blockquote): string {
      const body: string = this.parser.parse(tokens);
      const m = /^\s*<p>\[!([A-Za-z0-9-]+)\]([+-]?)[ \t]*([^\n<]*)(<br>|\n|(?=<\/p>))?/.exec(body);
      if (!m) return `<blockquote>\n${body}</blockquote>\n`;
      const type = m[1].toLowerCase();
      const title = m[3].trim() || type.charAt(0).toUpperCase() + type.slice(1);
      let rest = body.slice(m[0].length);
      rest = rest.startsWith("</p>") ? rest.slice(4) : `<p>${rest}`;
      return (
        `<div class="callout" data-callout="${escapeHtml(type)}">` +
        `<div class="callout-title"><div class="callout-title-inner">${title}</div></div>` +
        `<div class="callout-content">${rest}</div></div>\n`
      );
    },
  },
  extensions: [
    {
      name: "wikilink",
      level: "inline",
      start: (src: string) => src.indexOf("[["),
      tokenizer(src: string) {
        const m = WIKI.exec(src);
        return m ? { type: "wikilink", raw: m[0], embed: m[1] === "!", inner: m[2] } : undefined;
      },
      renderer(token: any) {
        const { target, alias } = splitWiki(token.inner as string);
        const t = escapeHtml(target);
        if (token.embed)
          return `<span class="internal-embed" data-href="${t}" data-alias="${escapeHtml(alias ?? "")}"></span>`;
        const shown = alias ?? (target.startsWith("#") ? target.slice(1) : target);
        return `<a class="internal-link" data-href="${t}" href="${t}">${escapeHtml(shown)}</a>`;
      },
    },
    {
      name: "highlight",
      level: "inline",
      start: (src: string) => src.indexOf("=="),
      tokenizer(this: any, src: string) {
        const m = /^==(?!\s)((?:[^=\n]|=(?!=))+?)(?<!\s)==/.exec(src);
        if (!m) return undefined;
        return { type: "highlight", raw: m[0], text: m[1], tokens: this.lexer.inlineTokens(m[1]) };
      },
      renderer(this: any, token: any) {
        return `<mark>${this.parser.parseInline(token.tokens)}</mark>`;
      },
    },
    {
      name: "math",
      level: "inline",
      start: (src: string) => src.indexOf("$"),
      tokenizer(src: string) {
        const block = /^\$\$([\s\S]+?)\$\$/.exec(src);
        if (block) return { type: "math", raw: block[0], text: block[1].trim(), block: true };
        // A closing `$` followed by a digit is a price, not math ("$5 and $10").
        const m = /^\$(?!\s)((?:[^$\n\\]|\\.)+?)(?<!\s)\$(?!\d)/.exec(src);
        return m ? { type: "math", raw: m[0], text: m[1], block: false } : undefined;
      },
      renderer: (token: any) =>
        `<span class="math ${token.block ? "math-block" : "math-inline"}">${escapeHtml(token.text as string)}</span>`,
    },
  ],
});

// ---------------------------------------------------------------- sanitizer

const SAFE_URI =
  /^(?:(?:https?|mailto|tel):|data:image\/(?:png|jpe?g|gif|webp|avif);base64,|[^a-z]|[a-z+.-]+(?:[^a-z+.:-]|$))/i;
const EXTERNAL = /^(?:https?|mailto|tel):/i;
const DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|avif);base64,[a-z0-9+/=\s]*$/i;
const CLASS_OK =
  /^(?:internal-link|internal-embed|is-unresolved|external-link|tag|callout|callout-title|callout-title-inner|callout-content|math|math-inline|math-block|task-list-item-checkbox|language-[\w+#.-]{1,40})$/;

const PLUGIN_TAGS = [...SAFE_TAGS, "input", "mark"];
const PLUGIN_ATTR = [
  ...SAFE_ATTR.filter((a) => a !== "target" && a !== "rel"),
  "class",
  "data-href",
  "data-alias",
  "data-callout",
  "type",
  "disabled",
  "checked",
];

function sanitizeNode(node: Element): void {
  // Allowlisted classes only: styling hooks, never page-level behavior.
  const cls = (node.getAttribute("class") ?? "").split(/\s+/).filter((c) => CLASS_OK.test(c));
  if (cls.length > 0) node.setAttribute("class", cls.join(" "));
  else node.removeAttribute("class");

  if (node.tagName === "INPUT") {
    // Static task-list glyph only.
    if (node.getAttribute("type") !== "checkbox") node.remove();
    else node.setAttribute("disabled", "");
    return;
  }
  const src = node.getAttribute("src");
  if (src !== null) {
    const v = src.trim();
    if (node.tagName !== "IMG") node.removeAttribute("src");
    else if (/^https?:/i.test(v)) node.setAttribute("src", v);
    else if (DATA_IMAGE.test(v)) node.setAttribute("src", v);
    else if (/^[a-z][a-z0-9+.-]*:/i.test(v) || v.startsWith("//")) node.removeAttribute("src");
    else {
      // Vault-relative image: resolved against the vault in the post-pass.
      node.setAttribute("data-href", v);
      node.removeAttribute("src");
    }
  }
  const href = node.getAttribute("href");
  if (href !== null) {
    const v = href.trim();
    if (node.tagName !== "A") node.removeAttribute("href");
    else if (EXTERNAL.test(v)) {
      node.setAttribute("href", v);
      node.setAttribute("rel", "noopener noreferrer nofollow");
      node.classList.add("external-link");
    } else if (v.startsWith("#") && !node.classList.contains("internal-link")) {
      node.setAttribute("href", v);
    } else if (node.classList.contains("internal-link") && !/^[a-z][a-z0-9+.-]*:/i.test(v)) {
      node.setAttribute("href", v);
    } else if (!/^[a-z][a-z0-9+.-]*:/i.test(v) && !v.startsWith("//")) {
      // `[x](Some%20Note.md)`: a relative markdown link is an internal link, as in Obsidian.
      let target = v;
      try {
        target = decodeURI(v);
      } catch {
        // keep the raw value
      }
      node.setAttribute("class", "internal-link");
      node.setAttribute("data-href", target);
      node.setAttribute("href", target);
    } else node.removeAttribute("href");
  }
  if (node.classList.contains("internal-link") && node.tagName !== "A")
    node.removeAttribute("class");
}

// ---------------------------------------------------------------- post-pass

const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|svg|bmp|avif)$/i;
const TAG_RE = /(^|[\s(])#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu;

function linkTags(root: HTMLElement): void {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!(n.textContent ?? "").includes("#")) continue;
    if (n.parentElement?.closest("a, code, pre, .math")) continue;
    texts.push(n as Text);
  }
  for (const text of texts) {
    const value = text.textContent ?? "";
    TAG_RE.lastIndex = 0;
    if (!TAG_RE.test(value)) continue;
    TAG_RE.lastIndex = 0;
    const frag = doc.createDocumentFragment();
    let last = 0;
    for (const m of value.matchAll(TAG_RE)) {
      const start = (m.index ?? 0) + m[1].length;
      frag.append(value.slice(last, start));
      const a = doc.createElement("a");
      a.className = "tag";
      a.setAttribute("href", `#${m[2]}`);
      a.textContent = `#${m[2]}`;
      frag.append(a);
      last = start + 1 + m[2].length;
    }
    frag.append(value.slice(last));
    text.replaceWith(frag);
  }
}

function resolveLinks(root: HTMLElement, app: App, sourcePath: string): void {
  for (const a of Array.from(root.querySelectorAll<HTMLAnchorElement>("a.internal-link"))) {
    const href = a.getAttribute("data-href") ?? "";
    const hash = href.indexOf("#");
    const path = hash < 0 ? href : href.slice(0, hash);
    const file = app.metadataCache.getFirstLinkpathDest(path, sourcePath);
    a.classList.toggle("is-unresolved", !file);
  }
}

/** `# Heading` section of `markdown` (up to the next heading of the same or higher level). */
export function extractSection(markdown: string, heading: string): string | null {
  const want = heading.trim().toLowerCase();
  const lines = markdown.split("\n");
  let level = 0;
  let start = -1;
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) fence = !fence;
    if (fence) continue;
    const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(lines[i]);
    if (!m) continue;
    if (start < 0) {
      if (m[2].trim().toLowerCase() === want) {
        start = i;
        level = m[1].length;
      }
    } else if (m[1].length <= level) {
      return lines.slice(start, i).join("\n");
    }
  }
  return start < 0 ? null : lines.slice(start).join("\n");
}

interface Pass {
  app: App;
  sourcePath: string;
  depth: number;
  /** Paths of the notes being rendered, outermost first (cycle guard). */
  chain: readonly string[];
  current: () => boolean;
  resourceUrl: (file: TFile) => string;
}

function unresolvedEmbed(doc: Document, label: string): HTMLElement {
  const span = doc.createElement("span");
  span.className = "internal-embed is-unresolved";
  span.textContent = label;
  return span;
}

async function resolveEmbeds(root: HTMLElement, pass: Pass): Promise<void> {
  const doc = root.ownerDocument;
  // Vault-relative `![](img.png)`: resolve like an embed.
  for (const img of Array.from(root.querySelectorAll<HTMLImageElement>("img[data-href]"))) {
    const file = pass.app.metadataCache.getFirstLinkpathDest(
      img.getAttribute("data-href") ?? "",
      pass.sourcePath,
    );
    img.removeAttribute("data-href");
    if (file && IMAGE_EXT.test(file.path)) img.setAttribute("src", pass.resourceUrl(file));
  }
  const embeds = Array.from(root.querySelectorAll<HTMLElement>("span.internal-embed[data-href]"));
  for (const el of embeds) {
    const raw = el.getAttribute("data-href") ?? "";
    const alias = el.getAttribute("data-alias") ?? "";
    const hash = raw.indexOf("#");
    const path = hash < 0 ? raw : raw.slice(0, hash);
    const fragment = hash < 0 ? "" : raw.slice(hash + 1);
    const file = pass.app.metadataCache.getFirstLinkpathDest(path, pass.sourcePath);
    let replacement: HTMLElement;
    if (!file) replacement = unresolvedEmbed(doc, raw);
    else if (IMAGE_EXT.test(file.path)) {
      const img = doc.createElement("img");
      img.className = "internal-embed image-embed";
      img.setAttribute("src", pass.resourceUrl(file));
      img.setAttribute("alt", alias || file.name);
      const size = /^(\d+)(?:x(\d+))?$/.exec(alias);
      if (size) {
        img.setAttribute("width", size[1]);
        if (size[2]) img.setAttribute("height", size[2]);
        img.setAttribute("alt", file.name);
      }
      replacement = img;
    } else if (file.extension !== "md") replacement = unresolvedEmbed(doc, raw);
    else if (pass.depth >= MAX_EMBED_DEPTH || pass.chain.includes(file.path))
      replacement = unresolvedEmbed(doc, raw);
    else {
      let body: string | null;
      try {
        body = parseFrontmatter(await pass.app.vault.cachedRead(file)).body;
      } catch (e) {
        console.error("[plugin] embed read failed:", e);
        body = null;
      }
      if (!pass.current()) return;
      const section =
        body !== null && fragment && !fragment.startsWith("^")
          ? extractSection(body, fragment.split("#").pop() ?? fragment)
          : body;
      if (section === null) replacement = unresolvedEmbed(doc, raw);
      else {
        const box = doc.createElement("div");
        box.className = "internal-embed markdown-embed";
        const content = doc.createElement("div");
        content.className = "markdown-embed-content";
        box.append(content);
        await fill(section, content, {
          ...pass,
          sourcePath: file.path,
          depth: pass.depth + 1,
          chain: [...pass.chain, file.path],
        });
        replacement = box;
      }
    }
    if (!pass.current()) return;
    el.replaceWith(replacement);
  }
}

// ---------------------------------------------------------------- entry

const withoutCode = (src: string, fn: (text: string) => string): string =>
  src
    .split(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]+`)/)
    .map((part, i) => (i % 2 === 0 ? fn(part) : part))
    .join("");

/** Markdown source -> sanitized, wiki-link-aware HTML (no vault needed). Exported for tests. */
export function markdownToSafeHtml(markdown: string): string {
  let src = markdown.length > MAX_CHARS ? markdown.slice(0, MAX_CHARS) : markdown;
  src = parseFrontmatter(src).body;
  src = withoutCode(src, (t) => t.replace(/%%[\s\S]*?(?:%%|$)/g, ""));
  const html = marked.parse(src, { async: false });
  return sanitizeHtml(
    html,
    { tags: PLUGIN_TAGS, attrs: PLUGIN_ATTR, uriRegexp: SAFE_URI },
    sanitizeNode,
  );
}

async function fill(markdown: string, el: HTMLElement, pass: Pass): Promise<void> {
  el.innerHTML = markdownToSafeHtml(markdown);
  linkTags(el);
  resolveLinks(el, pass.app, pass.sourcePath);
  await resolveEmbeds(el, pass);
}

// Per-element state: one set of listeners however many times Copilot re-renders a streaming
// message into the same element, and a generation counter so a slow embed read of render N
// never lands in the DOM of render N+1.
interface ElState {
  gen: number;
  app: App;
  sourcePath: string;
  off: () => void;
  owners: WeakSet<Component>;
}
const states = new WeakMap<HTMLElement, ElState>();

function attach(el: HTMLElement, app: App, sourcePath: string, component: Component): ElState {
  const existing = states.get(el);
  if (existing) {
    existing.app = app;
    existing.sourcePath = sourcePath;
    // A re-render owned by another component: its unload must also drop the listeners.
    if (!existing.owners.has(component)) {
      existing.owners.add(component);
      component.register(() => existing.off());
    }
    return existing;
  }
  const state: ElState = {
    gen: 0,
    app,
    sourcePath,
    off: () => {},
    owners: new WeakSet([component]),
  };
  const handler = (e: MouseEvent): void => {
    if (e.button > 1) return;
    const a = (e.target as Element | null)?.closest?.("a");
    if (!a || !el.contains(a)) return;
    if (e.type === "click" && e.button !== 0) return;
    if (a.classList.contains("internal-link")) {
      e.preventDefault();
      const href = a.getAttribute("data-href") ?? "";
      // Always a new main tab: the plugin's own view must stay where it is.
      state.app.workspace.openLinkText(href, state.sourcePath, true).catch((err: unknown) => {
        console.error("[plugin] openLinkText failed:", err);
        new Notice(`Cannot open "${href}": no such note`);
      });
    } else if (a.classList.contains("external-link")) {
      e.preventDefault();
      openExternalUrl(a.getAttribute("href") ?? "");
    } else {
      // Tags and same-page anchors must never navigate the webview.
      e.preventDefault();
    }
  };
  el.addEventListener("click", handler);
  el.addEventListener("auxclick", handler);
  state.off = () => {
    el.removeEventListener("click", handler);
    el.removeEventListener("auxclick", handler);
    states.delete(el);
  };
  states.set(el, state);
  component.register(() => state.off());
  return state;
}

export interface MarkdownRendererOptions {
  /** The app used when the caller passes none (the deprecated `renderMarkdown`). */
  app: App;
  /** Maps a vault file to a URL the webview can load. Default: Tauri asset URL. */
  resourceUrl?: (app: App, file: TFile) => string;
}

export function createMarkdownRenderer(options: MarkdownRendererOptions) {
  const resourceUrl =
    options.resourceUrl ??
    ((app: App, file: TFile) => convertFileSrc(app.vault.adapter.getFullPath(file.path)));
  return async (markdown: string, el: HTMLElement, ctx: MarkdownRenderContext): Promise<void> => {
    const app = ctx.app ?? options.app;
    const state = attach(el, app, ctx.sourcePath, ctx.component);
    const gen = ++state.gen;
    el.classList.add("markdown-rendered");
    await fill(markdown, el, {
      app,
      sourcePath: ctx.sourcePath,
      depth: 0,
      chain: ctx.sourcePath ? [ctx.sourcePath] : [],
      current: () => states.get(el)?.gen === gen,
      resourceUrl: (file) => resourceUrl(app, file),
    });
  };
}
