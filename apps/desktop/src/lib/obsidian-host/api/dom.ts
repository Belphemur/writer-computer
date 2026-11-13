// Adapted from opensidian (GPL-3.0-or-later).
// Obsidian's DOM helpers (createEl, createDiv, empty, addClass, ...). Plugins call these on
// plain elements, so they are installed on the DOM prototypes lazily: restricted mode (the
// default) never evaluates plugin code and never patches a prototype.

export interface DomElementInfo {
  cls?: string | string[];
  text?: string | DocumentFragment;
  attr?: Record<string, string | number | boolean | null>;
  title?: string;
  parent?: Node;
  value?: string;
  type?: string;
  prepend?: boolean;
  placeholder?: string;
  href?: string;
}

declare global {
  interface Node {
    createEl<K extends keyof HTMLElementTagNameMap>(
      tag: K,
      o?: DomElementInfo | string,
      cb?: (el: HTMLElementTagNameMap[K]) => void,
    ): HTMLElementTagNameMap[K];
    createDiv(o?: DomElementInfo | string, cb?: (el: HTMLDivElement) => void): HTMLDivElement;
    createSpan(o?: DomElementInfo | string, cb?: (el: HTMLSpanElement) => void): HTMLSpanElement;
    empty(): void;
    detach(): void;
    setText(text: string | DocumentFragment): void;
    appendText(text: string): void;
    createSvg(tag: string, o?: DomElementInfo | string): SVGElement;
    /** The document this node lives in (Obsidian's pop-out aware accessor). */
    readonly doc: Document;
    /** The window this node lives in. */
    readonly win: Window & typeof globalThis;
    instanceOf<T>(type: abstract new (...args: never[]) => T): this is T;
  }
  interface Event {
    instanceOf<T>(type: abstract new (...args: never[]) => T): this is T;
  }
  function createFragment(callback?: (el: DocumentFragment) => void): DocumentFragment;
  // eslint-disable-next-line no-var
  var activeDocument: Document;
  // eslint-disable-next-line no-var
  var activeWindow: Window & typeof globalThis;
  interface Element {
    addClass(...classes: string[]): void;
    addClasses(classes: string[]): void;
    removeClass(...classes: string[]): void;
    removeClasses(classes: string[]): void;
    toggleClass(classes: string | string[], on: boolean): void;
    hasClass(cls: string): boolean;
    setAttr(key: string, value: string | number | boolean | null): void;
    getAttr(key: string): string | null;
    /** Pop-out window migration hook. Writer has one window, so the callback never fires. */
    onWindowMigrated(callback: (win: Window) => void): () => void;
    find(selector: string): Element | null;
    findAll(selector: string): Element[];
  }
}

function applyInfo(el: HTMLElement, o: DomElementInfo | string | undefined): void {
  if (o === undefined) return;
  const info: DomElementInfo = typeof o === "string" ? { cls: o } : o;
  if (info.cls !== undefined) {
    const classes = Array.isArray(info.cls) ? info.cls : info.cls.split(/\s+/);
    for (const c of classes) if (c) el.classList.add(c);
  }
  if (info.text !== undefined) el.append(info.text);
  if (info.title !== undefined) el.title = info.title;
  if (info.attr) {
    for (const [k, v] of Object.entries(info.attr)) {
      if (v === null || v === false) el.removeAttribute(k);
      else el.setAttribute(k, v === true ? "" : String(v));
    }
  }
  const input = el as HTMLInputElement;
  if (info.value !== undefined) input.value = info.value;
  if (info.type !== undefined) input.type = info.type;
  if (info.placeholder !== undefined) input.placeholder = info.placeholder;
  if (info.href !== undefined) (el as HTMLAnchorElement).href = info.href;
  const parent = info.parent;
  if (parent) {
    if (info.prepend) parent.insertBefore(el, parent.firstChild);
    else parent.appendChild(el);
  }
}

export function createEl<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  o?: DomElementInfo | string,
  callback?: (el: HTMLElementTagNameMap[K]) => void,
  doc: Document = document,
): HTMLElementTagNameMap[K] {
  const el = doc.createElement(tag);
  applyInfo(el, o);
  callback?.(el);
  return el;
}

const installed = new Map<object, () => void>();

/**
 * Installs Obsidian's element helpers, `Node.doc/win/instanceOf` and the `createEl`/`activeDocument`
 * style globals on the given window. Idempotent per window. Returns an uninstaller that removes
 * exactly what this call added (members that already existed are never touched, never removed),
 * so destroying the host does not leak prototype patches into the app.
 */
export function installDomHelpers(win: Window & typeof globalThis = window): () => void {
  const prior = installed.get(win);
  if (prior) return prior;
  const added: { target: object; name: string }[] = [];
  const uninstall = (): void => {
    for (const { target, name } of added.reverse())
      delete (target as Record<string, unknown>)[name];
    added.length = 0;
    installed.delete(win);
  };
  installed.set(win, uninstall);
  const N = win.Node.prototype as unknown as Record<string, unknown>;
  const E = win.Element.prototype as unknown as Record<string, unknown>;
  const define = (target: Record<string, unknown>, name: string, fn: unknown): void => {
    if (name in target) return;
    Object.defineProperty(target, name, { value: fn, configurable: true, writable: true });
    added.push({ target, name });
  };
  // `Node.doc` / `Node.win`: the document / window an element lives in (pop-out aware in Obsidian;
  // Writer has a single window, so they fall back to the host window).
  const docOf = (n: Node): Document =>
    (n.nodeType === 9 ? (n as Document) : n.ownerDocument) ?? win.document;
  for (const [name, pick] of [
    ["doc", (n: Node) => docOf(n)],
    ["win", (n: Node) => docOf(n).defaultView ?? win],
  ] as const) {
    if (name in N) continue;
    Object.defineProperty(N, name, {
      get(this: Node) {
        return pick(this);
      },
      configurable: true,
    });
    added.push({ target: N, name });
  }
  // `el.instanceOf(Ctor)` / `evt.instanceOf(Ctor)`: cross-window safe instanceof (same window here).
  const instanceOf = function (this: unknown, ctor: new (...args: never[]) => unknown): boolean {
    return this instanceof ctor;
  };
  define(N, "instanceOf", instanceOf);
  define(win.Event.prototype as unknown as Record<string, unknown>, "instanceOf", instanceOf);

  define(E, "onWindowMigrated", () => () => {});

  const child = function (
    this: Node,
    tag: string,
    o?: DomElementInfo | string,
    cb?: (el: HTMLElement) => void,
  ) {
    const el = createEl(tag as "div", o, cb as never, this.ownerDocument ?? document);
    if (!el.parentNode) {
      const info = typeof o === "object" ? o : undefined;
      if (info?.prepend) this.insertBefore(el, this.firstChild);
      else this.appendChild(el);
    }
    return el;
  };
  define(N, "createEl", child);
  define(
    N,
    "createDiv",
    function (this: Node, o?: DomElementInfo | string, cb?: (el: HTMLElement) => void) {
      return (child as Function).call(this, "div", o, cb);
    },
  );
  define(
    N,
    "createSpan",
    function (this: Node, o?: DomElementInfo | string, cb?: (el: HTMLElement) => void) {
      return (child as Function).call(this, "span", o, cb);
    },
  );
  define(N, "createSvg", function (this: Node, tag: string, o?: DomElementInfo | string) {
    const el = (this.ownerDocument ?? document).createElementNS("http://www.w3.org/2000/svg", tag);
    applyInfo(el as unknown as HTMLElement, o);
    this.appendChild(el);
    return el;
  });
  define(N, "empty", function (this: Node) {
    while (this.firstChild) this.removeChild(this.firstChild);
  });
  define(N, "detach", function (this: Node) {
    this.parentNode?.removeChild(this);
  });
  define(N, "setText", function (this: Node, text: string | DocumentFragment) {
    this.textContent = typeof text === "string" ? text : "";
    if (typeof text !== "string") this.appendChild(text);
  });
  define(N, "appendText", function (this: Node, text: string) {
    this.appendChild((this.ownerDocument ?? document).createTextNode(text));
  });
  define(E, "addClass", function (this: Element, ...c: string[]) {
    this.classList.add(...c.flatMap((x) => x.split(/\s+/).filter(Boolean)));
  });
  define(E, "addClasses", function (this: Element, c: string[]) {
    this.classList.add(...c);
  });
  define(E, "removeClass", function (this: Element, ...c: string[]) {
    this.classList.remove(...c.flatMap((x) => x.split(/\s+/).filter(Boolean)));
  });
  define(E, "removeClasses", function (this: Element, c: string[]) {
    this.classList.remove(...c);
  });
  define(E, "toggleClass", function (this: Element, c: string | string[], on: boolean) {
    for (const x of Array.isArray(c) ? c : [c]) this.classList.toggle(x, on);
  });
  define(E, "hasClass", function (this: Element, c: string) {
    return this.classList.contains(c);
  });
  define(E, "setAttr", function (this: Element, k: string, v: string | number | boolean | null) {
    if (v === null) this.removeAttribute(k);
    else this.setAttribute(k, String(v));
  });
  define(
    E,
    "setAttrs",
    function (this: Element, a: Record<string, string | number | boolean | null>) {
      for (const [k, v] of Object.entries(a))
        (this as unknown as { setAttr(k: string, v: unknown): void }).setAttr(k, v);
    },
  );
  define(E, "getAttr", function (this: Element, k: string) {
    return this.getAttribute(k);
  });
  define(E, "find", function (this: Element, sel: string) {
    return this.querySelector(sel);
  });
  define(E, "findAll", function (this: Element, sel: string) {
    return Array.from(this.querySelectorAll(sel));
  });
  define(E, "show", function (this: HTMLElement) {
    this.style.display = "";
  });
  define(E, "hide", function (this: HTMLElement) {
    this.style.display = "none";
  });
  define(E, "isShown", function (this: HTMLElement) {
    return this.style.display !== "none";
  });
  define(E, "toggle", function (this: HTMLElement, on?: boolean) {
    this.style.display = (on ?? this.style.display === "none") ? "" : "none";
  });

  const G = win as unknown as Record<string, unknown>;
  define(
    G,
    "createEl",
    (tag: string, o?: DomElementInfo | string, cb?: (el: HTMLElement) => void) =>
      createEl(tag as "div", o, cb as never, win.document),
  );
  define(G, "createDiv", (o?: DomElementInfo | string, cb?: (el: HTMLElement) => void) =>
    createEl("div", o, cb, win.document),
  );
  define(G, "createSpan", (o?: DomElementInfo | string, cb?: (el: HTMLElement) => void) =>
    createEl("span", o, cb, win.document),
  );
  define(G, "createFragment", (cb?: (f: DocumentFragment) => void) => {
    const f = win.document.createDocumentFragment();
    cb?.(f);
    return f;
  });
  define(G, "createSvg", (tag: string, o?: DomElementInfo | string) => {
    const el = win.document.createElementNS("http://www.w3.org/2000/svg", tag);
    applyInfo(el as unknown as HTMLElement, o);
    return el;
  });
  define(G, "sleep", (ms: number) => new Promise<void>((r) => win.setTimeout(r, ms)));
  define(G, "nextFrame", () => new Promise<void>((r) => win.requestAnimationFrame(() => r())));
  define(G, "activeDocument", win.document);
  define(G, "activeWindow", win);
  return uninstall;
}
