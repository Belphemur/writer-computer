// Adapted from opensidian (GPL-3.0-or-later).
// Free functions of the `obsidian` module: debounce, normalizePath, YAML, icons, requestUrl,
// Platform, moment, fuzzy search, link parsing. Implemented by behavior from the public API.
import DOMPurify from "dompurify";
import momentLib from "moment";
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
  return yamlParse(text);
}

export function stringifyYaml(value: unknown): string {
  return yamlStringify(value);
}

// ---------------------------------------------------------------- icons

const customIcons = new Map<string, string>();
const FALLBACK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/></svg>';

/** Register an SVG icon (inner markup of a 0 0 100 100 viewBox, as in Obsidian). */
export function addIcon(name: string, svgContent: string): void {
  customIcons.set(name, svgContent);
}
export function removeIcon(name: string): void {
  customIcons.delete(name);
}
export function getIconIds(): string[] {
  return [...customIcons.keys()];
}

/**
 * lucide-react is not a dependency, so a registered icon renders as SVG and every other name
 * renders a neutral glyph tagged with `data-icon` / `lucide-<name>` so a host stylesheet or a
 * later icon pack can take over.
 */
export function getIcon(name: string): SVGSVGElement | null {
  if (typeof document === "undefined") return null;
  const host = document.createElement("div");
  const custom = customIcons.get(name);
  host.innerHTML = custom
    ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="1em" height="1em" fill="currentColor">${custom}</svg>`
    : FALLBACK_SVG;
  const svg = host.firstElementChild as SVGSVGElement | null;
  if (!svg) return null;
  svg.classList.add("svg-icon", `lucide-${name}`);
  svg.setAttribute("data-icon", name);
  return svg;
}

export function setIcon(parent: HTMLElement, iconId: string): void {
  parent.replaceChildren();
  const svg = getIcon(iconId);
  if (svg) parent.appendChild(svg);
  else parent.textContent = iconId;
}

// ---------------------------------------------------------------- platform

/**
 * `isDesktop`/`isMobile` describe the UI mode (Writer is a desktop-layout app). `isDesktopApp` means
 * "Electron": plugins gate Node/Electron `require`s on it (Copilot: `isDesktopApp && !isMobile`),
 * and Writer has neither, so it is false and such plugins degrade instead of crashing.
 */
export const Platform = {
  isDesktop: true,
  isMobile: false,
  isDesktopApp: false,
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

export interface RequestUrlParam {
  url: string;
  method?: string;
  contentType?: string;
  body?: string | ArrayBuffer;
  headers?: Record<string, string>;
  throw?: boolean;
}

export interface RequestUrlResponse {
  status: number;
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
  json: unknown;
  text: string;
}

export interface RequestUrlResponsePromise extends Promise<RequestUrlResponse> {
  readonly arrayBuffer: Promise<ArrayBuffer>;
  readonly json: Promise<unknown>;
  readonly text: Promise<string>;
}

/**
 * TODO: placeholder. Uses the webview's fetch (subject to CORS and the page CSP). To be
 * replaced by a Rust-backed https client so plugins can reach LLM APIs without CORS.
 */
export function requestUrl(request: RequestUrlParam | string): RequestUrlResponsePromise {
  const p: RequestUrlParam = typeof request === "string" ? { url: request } : request;
  const run = async (): Promise<RequestUrlResponse> => {
    const headers: Record<string, string> = { ...p.headers };
    if (p.contentType) headers["Content-Type"] = p.contentType;
    const res = await fetch(p.url, { method: p.method ?? "GET", headers, body: p.body });
    const buf = await res.arrayBuffer();
    const text = new TextDecoder().decode(buf);
    const outHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      outHeaders[k] = v;
    });
    if (p.throw !== false && res.status >= 400) {
      throw Object.assign(new Error(`Request failed, status ${res.status}`), {
        status: res.status,
      });
    }
    return {
      status: res.status,
      headers: outHeaders,
      arrayBuffer: buf,
      text,
      get json(): unknown {
        return JSON.parse(text);
      },
    };
  };
  const promise = run() as RequestUrlResponsePromise;
  // Lazy getters: an eager `.then` chain per shortcut would raise unhandled rejections when the
  // request itself fails and the caller only awaited the main promise.
  for (const key of ["arrayBuffer", "json", "text"] as const) {
    void Object.defineProperty(promise, key, {
      get: () => promise.then((r) => r[key]),
      configurable: true,
    });
  }
  return promise;
}

export async function request(request: RequestUrlParam | string): Promise<string> {
  return (await requestUrl(request)).text;
}

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

export type MarkdownRenderFn = (markdown: string, el: HTMLElement) => void;

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Placeholder renderer: paragraphs of escaped text. Replace with setMarkdownRenderer(). */
let renderMarkdownImpl: MarkdownRenderFn = (markdown, el) => {
  el.innerHTML = markdown
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
};

export function setMarkdownRenderer(fn: MarkdownRenderFn): void {
  renderMarkdownImpl = fn;
}

export function renderMarkdownInto(markdown: string, el: HTMLElement): void {
  renderMarkdownImpl(markdown, el);
}
