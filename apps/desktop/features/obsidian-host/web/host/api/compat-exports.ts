/* eslint-disable @typescript-eslint/no-explicit-any */
// The long tail of the public `obsidian` module: every exported class, function and constant of
// the public obsidian.d.ts that has no richer implementation elsewhere in the host. Plugins
// destructure these names at load (`class X extends SettingPage`, `getLanguage()` at module top
// level), so a missing name is a crash for the user, not a missing feature. Classes are real
// constructible bases; functions are working where cheap and documented no-ops otherwise.
// `tests/obsidian-host-module-exports.test.ts` pins the full list.
import { Component, Events } from "./core";
import { renderMatches, type SearchResult } from "./functions";
import { StringValue, Value } from "./bases-values";
import { ButtonComponent, Modal, TextComponent, ValueComponent } from "./ui";
import { createEl } from "./dom";
import { DataAdapter, TAbstractFile } from "./vault";
import type { App } from "./app";

// ---------------------------------------------------------------- functions

/** Current UI language code as Obsidian reports it: lowercase BCP-47 with the region kept ("en", "zh-tw", "pt-br"). */
export function getLanguage(): string {
  const raw =
    (typeof navigator !== "undefined" && (navigator.language || navigator.languages?.[0])) || "en";
  return raw.toLowerCase().replace(/_/g, "-") || "en";
}

export interface TooltipOptions {
  placement?: "bottom" | "right" | "left" | "top";
  classes?: string[];
  delay?: number;
  gap?: number;
}
/** Tooltips are native `title` attributes (Writer has no tooltip layer for plugins). */
export function setTooltip(el: HTMLElement, tooltip: string, _options?: TooltipOptions): void {
  el.setAttribute("aria-label", tooltip);
  el.setAttribute("title", tooltip);
}
export function displayTooltip(
  el: HTMLElement | { x: number; y: number },
  tooltip: string | DocumentFragment,
  _options?: TooltipOptions,
): void {
  if (el instanceof HTMLElement)
    setTooltip(el, typeof tooltip === "string" ? tooltip : (tooltip.textContent ?? ""));
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}
export function arrayBufferToHex(data: ArrayBuffer): string {
  return Array.from(new Uint8Array(data), (b) => b.toString(16).padStart(2, "0")).join("");
}
export function hexToArrayBuffer(hex: string): ArrayBuffer {
  const out = new Uint8Array(Math.floor(hex.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out.buffer;
}
export function getBlobArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  return blob.arrayBuffer();
}

export interface FrontMatterInfo {
  exists: boolean;
  frontmatter: string;
  from: number;
  to: number;
  contentStart: number;
}
export function getFrontMatterInfo(content: string): FrontMatterInfo {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)/.exec(content);
  if (!m) return { exists: false, frontmatter: "", from: 0, to: 0, contentStart: 0 };
  const from = content.indexOf("\n") + 1;
  return {
    exists: true,
    frontmatter: m[1],
    from,
    to: from + m[1].length,
    contentStart: m[0].length,
  };
}

export function parseFrontMatterStringArray(
  frontmatter: Record<string, unknown> | null | undefined,
  key: string | RegExp,
): string[] | null {
  if (!frontmatter) return null;
  const name = Object.keys(frontmatter).find((k) =>
    typeof key === "string" ? k.toLowerCase() === key.toLowerCase() : key.test(k),
  );
  if (name === undefined) return null;
  const v = frontmatter[name];
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") return v.split(/[,\s]+/).filter(Boolean);
  return null;
}

/** `"note.author"` -> `{ type: "note", name: "author" }`; ids without a known prefix are note properties. */
export function parsePropertyId(propertyId: string): { type: string; name: string } {
  const i = propertyId.indexOf(".");
  const head = i < 0 ? "" : propertyId.slice(0, i);
  if (head === "note" || head === "file" || head === "formula")
    return { type: head, name: propertyId.slice(i + 1) };
  return { type: "note", name: propertyId };
}

const HEADING_SPECIAL = /[!"#$%&()*+,.:;<=>?@^`{|}~/[\]\\]/g;
export function stripHeading(heading: string): string {
  return heading.replace(HEADING_SPECIAL, " ").replace(/\s+/g, " ").trim();
}
export function stripHeadingForLink(heading: string): string {
  return stripHeading(heading);
}

export function iterateRefs(refs: any[], cb: (ref: any) => boolean | void): boolean {
  for (const r of refs) if (cb(r) === true) return true;
  return false;
}
export function iterateCacheRefs(cache: any, cb: (ref: any) => boolean | void): boolean {
  return iterateRefs([...(cache?.links ?? []), ...(cache?.embeds ?? [])], cb);
}

/** Resolves `#Heading` / `#^block` against a note's cache. */
export function resolveSubpath(cache: any, subpath: string): unknown {
  const sub = subpath.replace(/^#/, "");
  if (sub.startsWith("^")) {
    const block = cache?.blocks?.[sub.slice(1).toLowerCase()];
    return block
      ? {
          type: "block",
          block,
          list: undefined,
          start: block.position.start,
          end: block.position.end,
        }
      : null;
  }
  const wanted = stripHeading(sub.split("#").pop() ?? "").toLowerCase();
  const headings: any[] = cache?.headings ?? [];
  const i = headings.findIndex((h) => stripHeading(h.heading).toLowerCase() === wanted);
  if (i < 0) return null;
  const current = headings[i];
  const next = headings.slice(i + 1).find((h) => h.level <= current.level) ?? null;
  return {
    type: "heading",
    current,
    next,
    start: current.position.start,
    end: next?.position.start ?? null,
  };
}

/** Minimal HTML -> text; tag structure is not converted to Markdown (documented gap). */
export function htmlToMarkdown(html: string | HTMLElement | Document | DocumentFragment): string {
  if (typeof html === "string") {
    const host = document.createElement("div");
    host.innerHTML = html;
    return host.textContent ?? "";
  }
  return html.textContent ?? "";
}

export async function loadMathJax(): Promise<void> {}
export async function loadMermaid(): Promise<unknown> {
  return undefined;
}
export async function loadPdfJs(): Promise<unknown> {
  return undefined;
}
export async function loadPrism(): Promise<unknown> {
  return undefined;
}
/** No MathJax in Writer: the source is shown in a span. */
export function renderMath(source: string, display: boolean): HTMLElement {
  const el = createEl("span", { cls: display ? "math math-block" : "math math-inline" });
  el.textContent = source;
  return el;
}
export async function finishRenderMath(): Promise<void> {}

export function renderResults(
  el: HTMLElement,
  text: string,
  result: SearchResult,
  offset = 0,
): void {
  renderMatches(
    el,
    text,
    result.matches.map(([a, b]): [number, number] => [a - offset, b - offset]),
  );
}
export function sortSearchResults(results: { match: SearchResult }[]): void {
  results.sort((a, b) => b.match.score - a.match.score);
}

// ---------------------------------------------------------------- components & modals

export class AbstractTextComponent extends TextComponent {}
export class MomentFormatComponent extends TextComponent {
  sampleEl: HTMLElement = createEl("span");
  setDefaultFormat(_format: string): this {
    return this;
  }
  setSampleEl(el: HTMLElement): this {
    this.sampleEl = el;
    return this;
  }
}
export class ProgressBarComponent extends ValueComponent<number> {
  private value = 0;
  constructor(public containerEl: HTMLElement) {
    super();
  }
  getValue(): number {
    return this.value;
  }
  setValue(value: number): this {
    this.value = value;
    return this;
  }
}
export class DisplayValueComponent {
  constructor(public containerEl: HTMLElement) {}
  setValue(_value: unknown): this {
    return this;
  }
}

export class ConfirmationButton extends ButtonComponent {
  onClick(handler: (evt: MouseEvent) => unknown): this {
    super.onClick(handler as never);
    return this;
  }
  setInitialFocus(): this {
    return this;
  }
  setSecondary(): this {
    this.buttonEl.classList.add("mod-secondary");
    return this;
  }
  setCancel(): this {
    this.buttonEl.classList.add("mod-cancel");
    return this;
  }
}
export class ConfirmationModal extends Modal {
  buttonContainerEl: HTMLElement;
  constructor(app: App) {
    super(app);
    this.buttonContainerEl = createEl("div", {
      cls: "modal-button-container",
      parent: this.modalEl,
    });
  }
  addClass(cls: string): this {
    this.modalEl.classList.add(cls);
    return this;
  }
  addCheckbox(label: string, cb: (value: boolean) => unknown): this {
    const l = createEl("label", { cls: "mod-checkbox", parent: this.contentEl });
    const input = createEl("input", { parent: l }) as HTMLInputElement;
    input.type = "checkbox";
    input.addEventListener("change", () => void cb(input.checked));
    l.append(label);
    return this;
  }
  addButton(cb: (btn: ConfirmationButton) => unknown): this {
    cb(new ConfirmationButton(this.buttonContainerEl));
    return this;
  }
  addCancelButton(text = "Cancel"): this {
    return this.addButton((b) =>
      b
        .setButtonText(text)
        .setCancel()
        .onClick(() => this.close()),
    );
  }
}

export { SettingGroup, SettingPage } from "./ui";

export class MenuSeparator {}

export class HoverPopover extends Component {
  hoverEl: HTMLElement = createEl("div", { cls: "hover-popover" });
  state: PopoverState = PopoverState.Showing;
  constructor(
    public parent: unknown,
    public targetEl: HTMLElement | null,
    _waitTime?: number,
    _staticPos?: unknown,
  ) {
    super();
  }
  hide(): void {
    this.state = PopoverState.Hidden;
    this.hoverEl.remove();
  }
  show(): void {
    this.state = PopoverState.Shown;
  }
}
export enum PopoverState {
  Showing,
  Shown,
  Hiding,
  Hidden,
}
export class RenderContext {
  constructor(public app?: App) {}
}
export class MarkdownPreviewRenderer {
  static registerPostProcessor(_processor: unknown, _sortOrder?: number): void {}
  static unregisterPostProcessor(_processor: unknown): void {}
  static createCodeBlockPostProcessor(_language: string, _handler: unknown): unknown {
    return () => {};
  }
}
export class MarkdownPreviewView extends Component {
  containerEl: HTMLElement = createEl("div", { cls: "markdown-preview-view" });
  constructor(public view?: unknown) {
    super();
  }
  get(): string {
    return "";
  }
  set(_data: string, _clear?: boolean): void {}
  clear(): void {}
  rerender(_full?: boolean): void {}
}
export class MarkdownEditView extends Component {
  constructor(public view?: unknown) {
    super();
  }
}

export class CapacitorAdapter extends DataAdapter {}
export class TExternalFile extends TAbstractFile {
  constructor(vault: any, path: string) {
    super(vault, path);
  }
}
export class NotNullValue extends Value {
  toString(): string {
    return "";
  }
}
export class TagValue extends StringValue {}
export class RelativeDateValue extends StringValue {}
export class BasesQueryResult {
  data: unknown[] = [];
  properties: unknown[] = [];
}
/** `Tasks` is exported (empty) by the public typings; nothing in Writer provides tasks. */
export class Tasks {}

// ---- workspace tree classes: constructible bases; the host keeps no layout tree

export class WorkspaceItem extends Events {
  parent: WorkspaceParent | null = null;
  getRoot(): WorkspaceItem {
    return this;
  }
  getContainer(): WorkspaceItem {
    return this;
  }
}
export class WorkspaceParent extends WorkspaceItem {
  children: WorkspaceItem[] = [];
  insertChild(index: number, child: WorkspaceItem, _resize?: boolean): void {
    this.children.splice(index, 0, child);
    child.parent = this;
  }
  removeChild(child: WorkspaceItem, _resize?: boolean): void {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
    if (child.parent === this) child.parent = null;
  }
  replaceChild(index: number, child: WorkspaceItem, _resize?: boolean): void {
    this.children[index] = child;
    child.parent = this;
  }
}
export class WorkspaceSplit extends WorkspaceParent {
  direction: "vertical" | "horizontal" = "vertical";
}
export class WorkspaceTabs extends WorkspaceParent {}
export class WorkspaceContainer extends WorkspaceSplit {
  win: Window = typeof window === "undefined" ? (undefined as never) : window;
  doc: Document = typeof document === "undefined" ? (undefined as never) : document;
}
export class WorkspaceRoot extends WorkspaceContainer {}
export class WorkspaceWindow extends WorkspaceContainer {}
export class WorkspaceFloating extends WorkspaceParent {}
export class WorkspaceSidedock extends WorkspaceSplit {
  collapsed = false;
  collapse(): void {
    this.collapsed = true;
  }
  expand(): void {
    this.collapsed = false;
  }
  toggle(): void {
    this.collapsed = !this.collapsed;
  }
}
export class WorkspaceMobileDrawer extends WorkspaceParent {}
export class WorkspaceRibbon {}
