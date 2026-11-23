// Real renderer behind MarkdownRenderer.render / renderMarkdown (installed with
// `setMarkdownRenderer`). Public Obsidian syntax only: wiki links, embeds, callouts, tags,
// ==highlight==, %%comments%%, task lists, math spans, frontmatter stripping.
//
// Pipeline: marked (context-free, module singleton) -> DOMPurify allowlist (shared core in
// lib/safe-html.ts) -> DOM post-pass that needs the vault (link resolution, tags, embeds).
// Input is untrusted (LLM output): the only way to get an element or attribute through is the
// allowlist below; the post-pass only creates elements itself.
import { convertFileSrc } from "@tauri-apps/api/core";
import { DOC_LINK_ABSOLUTE, DOC_LINK_SCHEMES } from "@/lib/external-url";
import { Marked, type Token, type Tokens } from "marked";
import { decorateRenderedCallouts, toggleRenderedCallout } from "@/lib/callouts/dom";
import { defaultCalloutTitle, parseCalloutHeader } from "@/lib/callouts/syntax";
import "@/lib/callouts/callouts.css";
import { parseFrontmatter } from "@/lib/frontmatter";
import { SAFE_ATTR, SAFE_TAGS, sanitizeHtml } from "@/lib/safe-html";
import { bindLinkActivation } from "@/lib/link-activation";
import { scanLineTags } from "@/lib/tags";
import { matchWikiLinkAtStart, parseWikiLink } from "@/lib/wiki-links";
import { openExternalUrl } from "../node/external-links";
import {
  findCodeBlockProcessor,
  fenceLanguage,
  mountCodeBlock,
  ProcessorContext,
  runPostProcessors,
} from "../markdown-processors";
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

/** Callout (`> [!type]+ Title`) as the documented DOM, or null for a plain quote. The header is
 *  read from the first paragraph's first line; the title renders as inline markdown and the
 *  rest of the quote through the normal parser, so nested callouts, lists and embeds work. */
function renderCallout(parser: { parse(tokens: Token[]): string }, tokens: Token[]): string | null {
  const first = tokens[0];
  if (first?.type !== "paragraph") return null;
  const text = (first as Tokens.Paragraph).text;
  const nl = text.indexOf("\n");
  const header = parseCalloutHeader(nl < 0 ? text : text.slice(0, nl));
  if (!header) return null;
  const rest = nl < 0 ? "" : text.slice(nl + 1);
  const title = header.title
    ? (marked.parseInline(header.title, { async: false }) as string)
    : escapeHtml(defaultCalloutTitle(header.type));
  const body =
    (rest.trim() ? (marked.parse(rest, { async: false }) as string) : "") +
    parser.parse(tokens.slice(1));
  const collapsible = header.fold !== "";
  const collapsed = header.fold === "-";
  const classes = ["callout", collapsible ? "is-collapsible" : "", collapsed ? "is-collapsed" : ""];
  const attrs =
    `data-callout="${escapeHtml(header.type)}" data-callout-fold="${header.fold}"` +
    (header.metadata ? ` data-callout-metadata="${escapeHtml(header.metadata)}"` : "");
  return (
    `<div class="${classes.filter(Boolean).join(" ")}" ${attrs}>` +
    `<div class="callout-title"><div class="callout-icon"></div>` +
    `<div class="callout-title-inner">${title}</div>` +
    (collapsible ? `<div class="callout-fold${collapsed ? " is-collapsed" : ""}"></div>` : "") +
    `</div>` +
    (body.trim() ? `<div class="callout-content">${body}</div>` : "") +
    `</div>\n`
  );
}

const marked = new Marked({
  gfm: true,
  // Obsidian's default ("Strict line breaks" off): a single newline inside a paragraph is a
  // visible line break in reading view. Chat output (Copilot) relies on it.
  breaks: true,
  renderer: {
    checkbox: ({ checked }: { checked: boolean }) =>
      `<input type="checkbox" class="task-list-item-checkbox" disabled${checked ? " checked" : ""}> `,
    blockquote(this: any, { tokens }: Tokens.Blockquote): string {
      return (
        renderCallout(this.parser, tokens) ??
        `<blockquote>\n${this.parser.parse(tokens)}</blockquote>\n`
      );
    },
  },
  extensions: [
    {
      name: "wikilink",
      level: "inline",
      start: (src: string) => src.indexOf("[["),
      tokenizer(src: string) {
        const m = matchWikiLinkAtStart(src);
        return m ? { type: "wikilink", ...m } : undefined;
      },
      renderer(token: any) {
        const { target, alias } = parseWikiLink(token.inner as string);
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

const SAFE_URI = new RegExp(
  `^(?:(?:${DOC_LINK_SCHEMES}):|data:image\\/(?:png|jpe?g|gif|webp|avif);base64,|[^a-z]|[a-z+.-]+(?:[^a-z+.:-]|$))`,
  "i",
);
const EXTERNAL = DOC_LINK_ABSOLUTE;
const DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|avif);base64,[a-z0-9+/=\s]*$/i;
const CLASS_OK =
  /^(?:internal-link|internal-embed|is-unresolved|external-link|tag|callout|callout-title|callout-title-inner|callout-content|callout-icon|callout-fold|is-collapsible|is-collapsed|math|math-inline|math-block|task-list-item-checkbox|language-[\w+#.-]{1,40})$/;

const PLUGIN_TAGS = [...SAFE_TAGS, "input", "mark"];
const PLUGIN_ATTR = [
  ...SAFE_ATTR.filter((a) => a !== "target" && a !== "rel"),
  "class",
  "data-href",
  "data-alias",
  "data-callout",
  "data-callout-fold",
  "data-callout-metadata",
  "type",
  "disabled",
  "checked",
];

function sanitizeNode(node: Element): void {
  // Allowlisted classes only: styling hooks, never page-level behavior.
  const cls = (node.getAttribute("class") ?? "").split(/\s+/).filter((c) => CLASS_OK.test(c));
  if (cls.length > 0) node.setAttribute("class", cls.join(" "));
  else node.removeAttribute("class");

  const fold = node.getAttribute("data-callout-fold");
  if (fold !== null && !/^[+-]?$/.test(fold)) node.removeAttribute("data-callout-fold");
  const meta = node.getAttribute("data-callout-metadata");
  if (meta !== null && meta.length > 200) node.removeAttribute("data-callout-metadata");

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
    const found = scanLineTags(value);
    if (found.length === 0) continue;
    const frag = doc.createDocumentFragment();
    let last = 0;
    for (const t of found) {
      frag.append(value.slice(last, t.from));
      const a = doc.createElement("a");
      a.className = "tag";
      a.setAttribute("href", `#${value.slice(t.from + 1, t.to)}`);
      a.textContent = value.slice(t.from, t.to);
      frag.append(a);
      last = t.to;
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
  /** Owns what the plugin processors attach (their components unload with it). */
  component: Component;
  /**
   * Run the plugins' code block and post processors over the result. Only for content that is a
   * vault note (a note preview, an embedded note): chat output and other generated markdown must
   * never reach `dataviewjs`-style processors, which evaluate code.
   */
  processors: boolean;
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
    } else if (file.extension === "base") {
      // A base is data, not text: a static render would need a live query (and ```base blocks in
      // untrusted markdown would run vault queries). Offer the link; the click handler opens it
      // in a new main tab like any internal link.
      const link = doc.createElement("a");
      link.className = "internal-link";
      link.setAttribute("data-href", raw);
      link.setAttribute("href", raw);
      link.textContent = `Open base: ${file.name}${fragment ? ` (${fragment})` : ""}`;
      replacement = link;
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
          processors: true, // the embedded text is a vault note
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
  decorateRenderedCallouts(el);
  linkTags(el);
  resolveLinks(el, pass.app, pass.sourcePath);
  await resolveEmbeds(el, pass);
  if (pass.processors && pass.current()) await runProcessors(el, pass);
}

/** Plugin code block processors replace their `pre`; post processors then see the whole tree. */
async function runProcessors(el: HTMLElement, pass: Pass): Promise<void> {
  const pending: Promise<void>[] = [];
  for (const code of Array.from(el.querySelectorAll<HTMLElement>("pre > code"))) {
    const pre = code.parentElement;
    const language = Array.from(code.classList)
      .find((c) => c.startsWith("language-"))
      ?.slice("language-".length);
    const proc = language ? findCodeBlockProcessor(fenceLanguage(language)) : null;
    if (!pre || !proc) continue;
    const mount = mountCodeBlock(
      proc,
      code.textContent?.replace(/\n$/, "") ?? "",
      pass.sourcePath,
      null,
    );
    pass.component.register(() => mount.dispose());
    pre.replaceWith(mount.el);
    pending.push(mount.ready);
  }
  const ctx = new ProcessorContext(pass.sourcePath, el);
  ctx.load();
  pass.component.register(() => ctx.unload());
  await runPostProcessors(el, ctx, pass.current);
  await Promise.all(pending);
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
  const toggleCallout = (e: MouseEvent): void => {
    if (e.button === 0) toggleRenderedCallout(e.target as Element, el);
  };
  // Links open through the shared activation (`lib/link-activation.ts`): left, middle and
  // Cmd/Ctrl clicks. Internal links always go to a new main tab: the plugin's own view must stay.
  const offLinks = bindLinkActivation(el, (target) => {
    const a = target.closest("a");
    if (!a || !el.contains(a)) return null;
    if (a.classList.contains("internal-link")) {
      const href = a.getAttribute("data-href") ?? "";
      return {
        kind: "custom",
        open: (intent) => {
          // `active: false` is Obsidian's own OpenViewState flag for a background tab.
          const openState = { active: intent !== "new-tab-background" };
          state.app.workspace
            .openLinkText(href, state.sourcePath, true, openState)
            .catch((err: unknown) => {
              console.error("[plugin] openLinkText failed:", err);
              new Notice(`Cannot open "${href}": no such note`);
            });
        },
      };
    }
    if (a.classList.contains("external-link"))
      return { kind: "custom", open: () => void openExternalUrl(a.getAttribute("href") ?? "") };
    // Tags and same-page anchors must never navigate the webview.
    return { kind: "custom", open: () => {} };
  });
  el.addEventListener("click", toggleCallout);
  state.off = () => {
    el.removeEventListener("click", toggleCallout);
    offLinks();
    states.delete(el);
  };
  states.set(el, state);
  component.register(() => state.off());
  return state;
}

/** True when `markdown` is the text of the vault note at `sourcePath` (with or without its frontmatter). */
async function isNoteContent(app: App, sourcePath: string, markdown: string): Promise<boolean> {
  const file = sourcePath ? app.vault.getFileByPath(sourcePath) : null;
  if (!file || file.extension !== "md") return false;
  try {
    const raw = await app.vault.cachedRead(file);
    const text = markdown.trim();
    return raw.trim() === text || parseFrontmatter(raw).body.trim() === text;
  } catch {
    return false;
  }
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
    const processors = await isNoteContent(app, ctx.sourcePath, markdown);
    if (states.get(el)?.gen !== gen) return;
    await fill(markdown, el, {
      app,
      sourcePath: ctx.sourcePath,
      depth: 0,
      chain: ctx.sourcePath ? [ctx.sourcePath] : [],
      current: () => states.get(el)?.gen === gen,
      resourceUrl: (file) => resourceUrl(app, file),
      component: ctx.component,
      processors,
    });
  };
}
