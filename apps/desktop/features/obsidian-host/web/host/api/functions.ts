// Adapted from opensidian (GPL-3.0-or-later).
// Free functions of the `obsidian` module: debounce, normalizePath, YAML, icons, requestUrl,
// Platform, moment, fuzzy search, link parsing. Implemented by behavior from the public API.
import DOMPurify from "dompurify";
import momentLib from "moment";
import type { App } from "./app";
import type { Component } from "./core";
import { logger } from "@/lib/logger";
import { BUILTIN_ICON_IDS, builtinIconMarkup } from "./icons";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";

/** Must be >= the highest `minAppVersion` of plugins we want to load (Copilot needs 1.11.4). */
export const apiVersion = "1.11.4";

export function requireApiVersion(version: string): boolean {
  const want = version.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const have = apiVersion.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const a = have[i] ?? 0;
    const b = want[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

// ---------------------------------------------------------------- debounce

export interface Debouncer<T extends unknown[], V> {
  (...args: T): Debouncer<T, V>;
  cancel(): Debouncer<T, V>;
  run(): V | void;
}

export function debounce<T extends unknown[], V>(
  cb: (...args: T) => V,
  timeout = 0,
  resetTimer = false,
): Debouncer<T, V> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: T | null = null;
  const fire = (): V | void => {
    timer = null;
    const args = pending;
    pending = null;
    if (args) return cb(...args);
  };
  const debounced = ((...args: T) => {
    pending = args;
    if (timer !== null && resetTimer) {
      clearTimeout(timer);
      timer = null;
    }
    if (timer === null) timer = setTimeout(fire, timeout);
    return debounced;
  }) as Debouncer<T, V>;
  debounced.cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    pending = null;
    return debounced;
  };
  debounced.run = () => {
    if (timer === null) return;
    clearTimeout(timer);
    return fire();
  };
  return debounced;
}

// ---------------------------------------------------------------- paths

/** Obsidian's normalizePath: forward slashes, collapsed, no leading/trailing slash. */
export function normalizePath(path: string): string {
  let p = path.replace(/[\\/]+/g, "/").replace(/ | /g, " ");
  p = p.replace(/^\/+/, "").replace(/\/+$/, "");
  return p === "" ? "/" : p;
}

// ---------------------------------------------------------------- yaml

export function parseYaml(text: string): unknown {
  // `logLevel: "error"`: a template's `{{date}}` value is a flow map used as a key, which `yaml`
  // would warn about on every parse; callers only need the value or the thrown error.
  return yamlParse(text, { logLevel: "error" });
}

export function stringifyYaml(value: unknown): string {
  return yamlStringify(value);
}

// ---------------------------------------------------------------- icons

const customIcons = new Map<string, string>();
const loggedUnknownIcons = new Set<string>();

/** Register an SVG icon (inner markup of a 0 0 100 100 viewBox, as in Obsidian). */
export function addIcon(name: string, svgContent: string): void {
  customIcons.set(name, svgContent);
}
export function removeIcon(name: string): void {
  customIcons.delete(name);
}
export function getIconIds(): string[] {
  return [...customIcons.keys(), ...BUILTIN_ICON_IDS];
}

const SVG_ATTRS = 'xmlns="http://www.w3.org/2000/svg" width="1em" height="1em"';

/**
 * Obsidian's getIcon: a registered (`addIcon`) icon, else a built-in one from ./icons, else null.
 * An unknown name is logged once (a plugin asking for an icon the host lacks is a host gap to
 * fix, not something to paper over with a placeholder glyph).
 */
export function getIcon(name: string): SVGSVGElement | null {
  if (typeof document === "undefined") return null;
  const custom = customIcons.get(name);
  const builtin = custom === undefined ? builtinIconMarkup(name) : null;
  if (custom === undefined && builtin === null) {
    if (!loggedUnknownIcons.has(name)) {
      loggedUnknownIcons.add(name);
      logger.warn("plugin", `[plugin-api] unknown icon "${name}" (add it to api/icons.ts)`, {
        phase: "missing-icon",
      });
    }
    return null;
  }
  const host = document.createElement("div");
  host.innerHTML =
    custom !== undefined
      ? `<svg ${SVG_ATTRS} viewBox="0 0 100 100" fill="currentColor">${custom}</svg>`
      : `<svg ${SVG_ATTRS} viewBox="0 0 24 24" fill="none">${builtin}</svg>`;
  const svg = host.firstElementChild as SVGSVGElement | null;
  if (!svg) return null;
  svg.classList.add("svg-icon", `lucide-${name.replace(/^lucide-/, "")}`);
  svg.setAttribute("data-icon", name);
  return svg;
}

/** Replaces the children of `parent` with the icon; an unknown icon leaves it empty. */
export function setIcon(parent: HTMLElement, iconId: string): void {
  parent.replaceChildren();
  const svg = getIcon(iconId);
  if (svg) parent.appendChild(svg);
}

// ---------------------------------------------------------------- platform

/**
 * `isDesktop`/`isMobile` describe the UI mode (Writer is a desktop-layout app). `isDesktopApp` means
 * "Electron": plugins gate Node/Electron `require`s on it (Copilot: `isDesktopApp && !isMobile`).
 * It is true because the host always wires the Node surface (`./node/`: `require`, `process`,
 * `Buffer`, and the globals installed while a plugin is loaded) for every plugin; the flag is
 * only honest while that wiring is active, so do not set it from code that bypasses `PluginHost`.
 */
export const Platform = {
  isDesktop: true,
  isMobile: false,
  isDesktopApp: true,
  isMobileApp: false,
  isIosApp: false,
  isAndroidApp: false,
  isPhone: false,
  isTablet: false,
  isMacOS: typeof navigator !== "undefined" && /Mac/i.test(navigator.platform ?? ""),
  isWin: typeof navigator !== "undefined" && /Win/i.test(navigator.platform ?? ""),
  isLinux: typeof navigator !== "undefined" && /Linux/i.test(navigator.platform ?? ""),
  isSafari: false,
  resourcePathPrefix: "writer-vault://localhost/",
} as const;

// ---------------------------------------------------------------- requestUrl

// Implemented over the Rust plugin_http_request command (CORS-free); see ./network.
export { request, requestUrl } from "./network";
export type { RequestUrlParam, RequestUrlResponse, RequestUrlResponsePromise } from "./network";

// ---------------------------------------------------------------- moment

/**
 * The real `moment` library, as Obsidian exposes it. It is synchronous for plugins, so it is a
 * static import here; the whole host is dynamic-imported by the plugins store, which keeps
 * moment out of the app's entry chunk.
 */
export const moment = momentLib;

// ---------------------------------------------------------------- search

export interface SearchResult {
  score: number;
  matches: [number, number][];
}

export function prepareSimpleSearch(query: string): (text: string) => SearchResult | null {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return (text) => {
    const lower = text.toLowerCase();
    const matches: [number, number][] = [];
    for (const t of terms) {
      const i = lower.indexOf(t);
      if (i < 0) return null;
      matches.push([i, i + t.length]);
    }
    return { score: -matches.reduce((a, m) => a + m[0], 0), matches };
  };
}

export function prepareFuzzySearch(query: string): (text: string) => SearchResult | null {
  const q = query.toLowerCase();
  return (text) => {
    if (!q) return { score: 0, matches: [] };
    const lower = text.toLowerCase();
    const matches: [number, number][] = [];
    let ti = 0;
    let gaps = 0;
    for (const ch of q) {
      const at = lower.indexOf(ch, ti);
      if (at < 0) return null;
      gaps += at - ti;
      const last = matches[matches.length - 1];
      if (last && last[1] === at) last[1] = at + 1;
      else matches.push([at, at + 1]);
      ti = at + 1;
    }
    return { score: -gaps - (lower.length - q.length) / 100, matches };
  };
}

export function renderMatches(
  el: HTMLElement | DocumentFragment,
  text: string,
  matches: [number, number][] | null,
): void {
  const doc = el.ownerDocument ?? document;
  let pos = 0;
  for (const [s, e] of matches ?? []) {
    if (s > pos) el.appendChild(doc.createTextNode(text.slice(pos, s)));
    const span = doc.createElement("span");
    span.className = "suggestion-highlight";
    span.textContent = text.slice(s, e);
    el.appendChild(span);
    pos = e;
  }
  if (pos < text.length) el.appendChild(doc.createTextNode(text.slice(pos)));
}

// ---------------------------------------------------------------- links, tags, frontmatter helpers

export function getLinkpath(linktext: string): string {
  return parseLinktext(linktext).path;
}

export function parseLinktext(linktext: string): { path: string; subpath: string } {
  const i = linktext.indexOf("#");
  if (i < 0) return { path: linktext, subpath: "" };
  return { path: linktext.slice(0, i), subpath: linktext.slice(i) };
}

export function parseFrontMatterEntry(
  frontmatter: Record<string, unknown> | null | undefined,
  key: string | RegExp,
): unknown {
  if (!frontmatter) return null;
  for (const k of Object.keys(frontmatter)) {
    if (typeof key === "string" ? k.toLowerCase() === key.toLowerCase() : key.test(k))
      return frontmatter[k] ?? null;
  }
  return null;
}

function asStringList(value: unknown): string[] | null {
  if (value === null || value === undefined) return null;
  let list: unknown[];
  if (Array.isArray(value)) list = value;
  else if (typeof value === "string" || typeof value === "number") {
    list = String(value).split(/[,\s]+/);
  } else return null;
  const out = list.map((v) => String(v as string).trim()).filter(Boolean);
  return out.length > 0 ? out : null;
}

export function parseFrontMatterTags(
  frontmatter: Record<string, unknown> | null | undefined,
): string[] | null {
  const raw = asStringList(parseFrontMatterEntry(frontmatter, /^tags?$/i));
  return raw ? raw.map((t) => (t.startsWith("#") ? t : `#${t}`)) : null;
}

export function parseFrontMatterAliases(
  frontmatter: Record<string, unknown> | null | undefined,
): string[] | null {
  return asStringList(parseFrontMatterEntry(frontmatter, /^aliases?$/i));
}

export function sanitizeHTMLToDom(html: string): DocumentFragment {
  return DOMPurify.sanitize(html, { RETURN_DOM_FRAGMENT: true }) as DocumentFragment;
}

// ---------------------------------------------------------------- markdown rendering

export interface MarkdownRenderContext {
  /** Absent for the deprecated `renderMarkdown`, which has no app argument. */
  app?: App;
  sourcePath: string;
  /** Owns the listeners the renderer attaches; unloading it removes them. */
  component: Component;
}

export type MarkdownRenderFn = (
  markdown: string,
  el: HTMLElement,
  ctx: MarkdownRenderContext,
) => void | Promise<void>;

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Fallback when no host is installed: paragraphs of escaped text. */
const placeholderRenderer: MarkdownRenderFn = (markdown, el) => {
  el.innerHTML = markdown
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
};

let renderMarkdownImpl: MarkdownRenderFn = placeholderRenderer;

/** Installs the renderer behind MarkdownRenderer.render; returns the remover (restores the
 *  placeholder when `fn` is still the active one). */
export function setMarkdownRenderer(fn: MarkdownRenderFn): () => void {
  renderMarkdownImpl = fn;
  return () => {
    if (renderMarkdownImpl === fn) renderMarkdownImpl = placeholderRenderer;
  };
}

export async function renderMarkdownInto(
  markdown: string,
  el: HTMLElement,
  ctx: MarkdownRenderContext,
): Promise<void> {
  await renderMarkdownImpl(markdown, el, ctx);
}
