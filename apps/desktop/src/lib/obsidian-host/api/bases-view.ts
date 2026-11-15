// `Plugin.registerBasesView` and the public `BasesView` API (spec 4.6). A plugin's view type is
// registered in the same registry the built-in table/cards/list use (`lib/bases/view-registry`),
// owned by the plugin id so disabling the plugin removes it. The host owns the `BasesView`
// instance: it creates it from the plugin's factory, hands it a fresh `BasesQueryResult` and calls
// `onDataUpdated()` (coalesced per animation frame) after every data or config change, and
// unloads it when the view is replaced, the tab closes or the plugin is disabled.
//
// Clean-room: written from the public `obsidian.d.ts` Bases types and the "Build a Bases view"
// developer guide. `QueryController` and `FormulaContext` are opaque there; these are ours.
import { canonicalPropertyKey } from "@/lib/bases/cells";
import { baseEval } from "@/lib/bases/ipc";
import type {
  BaseDocument,
  BaseQueryResult,
  BaseView as BaseViewConfigData,
  Cell,
} from "@/lib/bases/types";
import { registerBaseView, type BaseViewProps, type MountedView } from "@/lib/bases/view-registry";
import { flattenOptions, type ViewOption } from "@/lib/bases/view-options";
import { recordPluginError } from "../error-log";
import type { App } from "./app";
import { Component } from "./core";
import { ErrorValue, NullValue, toValue, Value } from "./bases-values";
import { TFile } from "./vault";

/** `note.x`, `file.x` or `formula.x` (the public `BasesPropertyId`). */
export type BasesPropertyId = `note.${string}` | `file.${string}` | `formula.${string}`;

export function toPropertyId(id: string): BasesPropertyId {
  return (/^(note|file|formula)\./.test(id) ? id : `note.${id}`) as BasesPropertyId;
}

/** Keys the typed view model owns: a plugin cannot overwrite them through `config.set`. */
const RESERVED_KEYS = new Set([
  "type",
  "name",
  "filters",
  "groupBy",
  "groupOrder",
  "sort",
  "order",
  "limit",
  "columnSize",
  "summaries",
]);

// ---------------------------------------------------------------- data model

export class BasesEntry {
  constructor(
    public file: TFile,
    /** @internal */ readonly _row: number,
    private columns: ReadonlyMap<string, Cell>,
  ) {}
  /** The value of a property for this file, or `null` when the view did not query it. */
  getValue(propertyId: BasesPropertyId): Value | null {
    const cell = this.columns.get(canonicalPropertyKey(propertyId));
    return cell ? toValue(cell) : null;
  }
}

export class BasesEntryGroup {
  constructor(
    public entries: BasesEntry[],
    public key?: Value,
  ) {}
  hasKey(): boolean {
    return this.key !== undefined;
  }
}

export interface BasesQueryResult {
  data: BasesEntry[];
  groupedData: BasesEntryGroup[];
  properties: BasesPropertyId[];
  getSummaryValue(
    controller: unknown,
    entries: BasesEntry[],
    prop: BasesPropertyId,
    summaryKey: string,
  ): Value;
}

/** A fresh result for one `onDataUpdated` call; nothing in it is reused between calls. */
export function buildQueryResult(app: App, props: BaseViewProps): BasesQueryResult {
  const { result } = props;
  const keys = result.columns.map((c) => c.key);
  const entries = result.rows.map((row, i) => {
    const file = app.vault.getFileByPath(row.path) ?? new TFile(app.vault, row.path);
    const cells = new Map<string, Cell>();
    keys.forEach((k, c) => {
      const cell = row.cells[c];
      if (cell) cells.set(k, cell);
    });
    return new BasesEntry(file, i, cells);
  });
  const groups = result.groups;
  const groupedData = groups
    ? groups.map(
        (g) => new BasesEntryGroup(entries.slice(g.start, g.start + g.len), toValue(g.key)),
      )
    : [new BasesEntryGroup(entries)];
  const summaryOf = (entriesIn: BasesEntry[], prop: BasesPropertyId, summaryKey: string): Value => {
    const c = result.columns.findIndex((col) => col.key === canonicalPropertyKey(prop));
    const column = result.columns[c];
    if (!column || column.summary !== summaryKey)
      return new ErrorValue(`Summary "${summaryKey}" is not configured for ${prop} in this view`);
    const rows = new Set(entriesIn.map((e) => e._row));
    if (rows.size === entries.length) {
      const cell = result.summaries[c];
      return cell ? toValue(cell) : NullValue.value;
    }
    const gi = groups?.findIndex(
      (g) =>
        g.len === rows.size &&
        Array.from({ length: g.len }, (_, k) => g.start + k).every((r) => rows.has(r)),
    );
    if (groups && gi !== undefined && gi >= 0) {
      const cell = groups[gi]!.summaries[c];
      return cell ? toValue(cell) : NullValue.value;
    }
    return new ErrorValue("Writer only provides summaries for the whole result or one whole group");
  };
  return {
    data: entries,
    groupedData,
    properties: result.columns.slice(0, props.shown).map((c) => toPropertyId(c.id)),
    getSummaryValue: (_controller, es, prop, key) => summaryOf(es, prop, key),
  };
}

// ---------------------------------------------------------------- config

export interface BasesSortConfig {
  property: BasesPropertyId;
  direction: "ASC" | "DESC";
}

/** The `config` of a view (`BasesViewConfig`): live reads of the current view, writes to its YAML. */
export class BasesViewConfig {
  /** Evaluated `formula` options, refreshed by the host before each `onDataUpdated`. */
  readonly formulas = new Map<string, Value>();
  constructor(private source: () => ConfigSource) {}

  get name(): string {
    return this.source().view?.name ?? "";
  }

  get(key: string): unknown {
    const view = this.source().view as (BaseViewConfigData & Record<string, unknown>) | undefined;
    if (!view) return undefined;
    if (key in view.extra) return view.extra[key];
    return RESERVED_KEYS.has(key) ? (view as Record<string, unknown>)[key] : undefined;
  }

  getAsPropertyId(key: string): BasesPropertyId | null {
    const v = this.get(key);
    return typeof v === "string" && v !== "" ? toPropertyId(v) : null;
  }

  /** The value of a `formula` option, evaluated by the host with `this` set (see `evaluateFormulas`). */
  getEvaluatedFormula(_view: unknown, key: string): Value {
    return (
      this.formulas.get(key) ??
      new ErrorValue(`"${key}" is not a formula option of this view (declare it in options())`)
    );
  }

  set(key: string, value: unknown): void {
    if (RESERVED_KEYS.has(key))
      throw new Error(`config.set("${key}"): that key belongs to Writer's view model`);
    const config = this.source().config;
    if (!config) throw new Error("config.set: the view is not attached to a base");
    config.setOption(key, value === null ? undefined : value);
  }

  getOrder(): BasesPropertyId[] {
    const { view, result } = this.source();
    const order = view?.order ?? result?.columns.slice(0, 1).map((c) => c.id) ?? [];
    return order.map(toPropertyId);
  }

  getSort(): BasesSortConfig[] {
    return (this.source().view?.sort ?? []).map((s) => ({
      property: toPropertyId(s.property),
      direction: s.direction,
    }));
  }

  getDisplayName(prop: BasesPropertyId): string {
    const { document, result } = this.source();
    const key = canonicalPropertyKey(prop);
    const col = result?.columns.find((c) => c.key === key);
    if (col) return col.displayName;
    return document?.properties[prop]?.displayName ?? document?.properties[key]?.displayName ?? key;
  }
}

interface ConfigSource {
  view: BaseViewConfigData | undefined;
  document: BaseDocument | null;
  result: BaseQueryResult | null;
  config: BaseViewProps["config"] | null;
}

// ---------------------------------------------------------------- controller and view

/** Opaque to plugins: handed to the factory and to `BasesView`'s constructor. */
export class QueryController {
  /** @internal */
  constructor(
    readonly _app: App,
    readonly _config: BasesViewConfig,
    readonly _path: string,
  ) {}
}

/** Base class of a plugin's view (`BasesView`). The host calls `onDataUpdated()`. */
export abstract class BasesView extends Component {
  abstract type: string;
  app: App;
  config: BasesViewConfig;
  data: BasesQueryResult;
  allProperties: BasesPropertyId[] = [];
  private _controller: QueryController;

  constructor(controller: QueryController) {
    super();
    this._controller = controller;
    this.app = controller._app;
    this.config = controller._config;
    this.data = {
      data: [],
      groupedData: [],
      properties: [],
      getSummaryValue: () => NullValue.value,
    };
  }

  abstract onDataUpdated(): void;

  /** Create a note in the base's folder (named `baseFileName`), apply `frontmatterProcessor`, open it. */
  async createFileForView(
    baseFileName?: string,
    frontmatterProcessor?: (frontmatter: Record<string, unknown>) => void,
  ): Promise<void> {
    const basePath = this._controller._path;
    const root = this.app.vault.io.basePath.replace(/\/+$/, "");
    const rel = basePath.startsWith(`${root}/`) ? basePath.slice(root.length + 1) : basePath;
    const folder = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    const stem = (baseFileName ?? "Untitled").replace(/[\\/:*?"<>|]/g, "-").replace(/\.md$/i, "");
    let n = 0;
    let path = "";
    do {
      path = `${folder ? `${folder}/` : ""}${stem}${n === 0 ? "" : ` ${n}`}.md`;
      n++;
    } while (this.app.vault.getAbstractFileByPath(path));
    const file = await this.app.vault.create(path, "");
    if (frontmatterProcessor)
      await this.app.fileManager.processFrontMatter(file, frontmatterProcessor);
    await this.app.workspace.getLeaf(true).openFile(file);
  }
}

// ---------------------------------------------------------------- options

interface PluginOption {
  type?: unknown;
  displayName?: unknown;
  key?: unknown;
  default?: unknown;
  options?: unknown;
  min?: unknown;
  max?: unknown;
  step?: unknown;
  placeholder?: unknown;
  items?: unknown;
}

const VALUE_OPTION_TYPES = new Set([
  "dropdown",
  "file",
  "folder",
  "formula",
  "multitext",
  "property",
  "slider",
  "text",
  "toggle",
]);

/** Plugin option descriptors (`BasesAllOptions[]`) as the host's `ViewOption`s. Throws on bad input. */
export function adaptOptions(raw: unknown): ViewOption[] {
  if (!Array.isArray(raw)) throw new TypeError("options() must return an array");
  return raw.map((o: PluginOption): ViewOption => {
    const displayName = typeof o.displayName === "string" ? o.displayName : "";
    if (o.type === "group") {
      return { type: "group", displayName, items: adaptOptions(o.items ?? []) };
    }
    if (typeof o.type !== "string" || !VALUE_OPTION_TYPES.has(o.type))
      throw new TypeError(`Unknown option type: ${String(o.type)}`);
    if (typeof o.key !== "string" || o.key === "")
      throw new TypeError(`Option "${displayName}" needs a key`);
    if (RESERVED_KEYS.has(o.key))
      throw new TypeError(`Option key "${o.key}" is reserved by Writer`);
    const base = { displayName, key: o.key };
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    switch (o.type) {
      case "dropdown":
        return {
          ...base,
          type: "dropdown",
          default: str(o.default),
          options: (o.options && typeof o.options === "object" ? o.options : {}) as Record<
            string,
            string
          >,
        };
      case "slider":
        return {
          ...base,
          type: "slider",
          default: typeof o.default === "number" ? o.default : undefined,
          min: typeof o.min === "number" ? o.min : 0,
          max: typeof o.max === "number" ? o.max : 100,
          step: typeof o.step === "number" ? o.step : 1,
        };
      case "toggle":
        return {
          ...base,
          type: "toggle",
          default: typeof o.default === "boolean" ? o.default : undefined,
        };
      case "multitext":
        return {
          ...base,
          type: "multitext",
          default: Array.isArray(o.default) ? o.default.map(String) : undefined,
        };
      default:
        return {
          ...base,
          type: o.type as "text" | "property" | "formula" | "file" | "folder",
          default: str(o.default),
          placeholder: str(o.placeholder),
        };
    }
  });
}

/** A `.base` text holding only the document's formulas (YAML accepts JSON strings), for `base_eval`. */
function formulaSource(document: BaseDocument | null): string | null {
  const entries = Object.entries(document?.formulas ?? {});
  if (entries.length === 0) return null;
  return `formulas:\n${entries.map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join("\n")}\n`;
}

// ---------------------------------------------------------------- mounting

type Factory = (controller: QueryController, container: HTMLElement) => BasesView;

interface Registration {
  name: string;
  icon: string;
  factory: Factory;
  options?: (config: BasesViewConfig) => unknown;
}

const nextFrame: (fn: () => void) => () => void = (fn) => {
  if (typeof requestAnimationFrame === "function") {
    const id = requestAnimationFrame(fn);
    return () => cancelAnimationFrame(id);
  }
  const id = setTimeout(fn, 16);
  return () => clearTimeout(id);
};

/** The container of a plugin view shows a plugin failure instead of hiding it. */
function showError(container: HTMLElement, pluginId: string, what: string, e: unknown): void {
  console.error(`[plugin] ${pluginId} Bases view ${what}:`, e);
  recordPluginError(pluginId, `bases-view:${what}`, e);
  let el = container.querySelector<HTMLElement>(":scope > [data-base-plugin-error]");
  if (!el) {
    el = container.ownerDocument.createElement("div");
    el.setAttribute("data-base-plugin-error", "");
    el.setAttribute("role", "alert");
    el.style.cssText = "padding:8px 12px;color:var(--danger,#e5484d);font-size:13px";
    container.prepend(el);
  }
  el.textContent = `The ${pluginId} view failed (${what}): ${e instanceof Error ? e.message : String(e)}`;
}

function clearError(container: HTMLElement): void {
  container.querySelector(":scope > [data-base-plugin-error]")?.remove();
}

/**
 * One mounted plugin view. `update(props)` stores the latest props and schedules one flush per
 * animation frame; a flush evaluates the declared `formula` options (async, `base_eval`), builds a
 * fresh `BasesQueryResult` and calls `onDataUpdated()`. A flush that a newer update overtook while
 * evaluating formulas is dropped (the newer one delivers).
 */
export class PluginViewInstance implements MountedView {
  private view: BasesView | null = null;
  private props: BaseViewProps;
  private cancelFrame: (() => void) | null = null;
  private generation = 0;
  private destroyed = false;
  private readonly config: BasesViewConfig;

  constructor(
    private app: App,
    private pluginId: string,
    private reg: Registration,
    private container: HTMLElement,
    props: BaseViewProps,
  ) {
    this.props = props;
    this.config = new BasesViewConfig(() => ({
      view: this.props.view,
      document: this.props.document,
      result: this.props.result,
      config: this.props.config,
    }));
    try {
      const view = reg.factory(new QueryController(app, this.config, props.path), container);
      if (!view || typeof view.onDataUpdated !== "function")
        throw new TypeError("the factory must return a BasesView");
      this.view = view;
      view.load();
    } catch (e) {
      showError(container, pluginId, "factory", e);
      this.view = null;
      return;
    }
    this.schedule();
  }

  update(props: BaseViewProps): void {
    this.props = props;
    this.schedule();
  }

  destroy(): void {
    this.destroyed = true;
    this.cancelFrame?.();
    this.cancelFrame = null;
    const view = this.view;
    this.view = null;
    try {
      view?.unload();
    } catch (e) {
      recordPluginError(this.pluginId, "bases-view:unload", e);
    }
    this.container.replaceChildren();
  }

  private schedule(): void {
    if (!this.view || this.destroyed || this.cancelFrame) return;
    this.cancelFrame = nextFrame(() => {
      this.cancelFrame = null;
      void this.flush();
    });
  }

  private async flush(): Promise<void> {
    const view = this.view;
    if (!view || this.destroyed) return;
    const gen = ++this.generation;
    const props = this.props;
    try {
      await this.evaluateFormulas(props);
      if (this.destroyed || gen !== this.generation) return;
      const data = buildQueryResult(this.app, props);
      view.data = data;
      view.allProperties = props.result.columns.map((c) => toPropertyId(c.id));
      clearError(this.container);
      view.onDataUpdated();
    } catch (e) {
      showError(this.container, this.pluginId, "onDataUpdated", e);
    }
  }

  /** Evaluate every `formula` option of the view with `this` = the base file; cache the results. */
  private async evaluateFormulas(props: BaseViewProps): Promise<void> {
    const view = props.view;
    if (!view || !this.reg.options) return;
    const options = flattenOptions(adaptOptions(this.reg.options(this.config)));
    const next = new Map<string, Value>();
    await Promise.all(
      options
        .filter((o) => o.type === "formula")
        .map(async (o) => {
          const expression = view.extra[o.key];
          if (typeof expression !== "string" || expression.trim() === "") {
            next.set(o.key, NullValue.value);
            return;
          }
          try {
            const cell = await baseEval({
              expression,
              thisPath: props.path,
              nowOffsetMinutes: -new Date().getTimezoneOffset(),
              ...(formulaSource(props.document) ? { text: formulaSource(props.document)! } : {}),
            });
            next.set(o.key, toValue(cell));
          } catch (e) {
            next.set(o.key, new ErrorValue(e instanceof Error ? e.message : String(e)));
          }
        }),
    );
    this.config.formulas.clear();
    for (const [k, v] of next) this.config.formulas.set(k, v);
  }
}

/**
 * `Plugin.registerBasesView(viewId, registration)`: returns `true` when the type was registered,
 * `false` when it already was (built-in or another plugin). A malformed registration throws.
 */
export function registerPluginBasesView(
  app: App,
  pluginId: string,
  viewId: string,
  registration: unknown,
): boolean {
  const reg = registration as Partial<Registration> | null;
  if (typeof viewId !== "string" || viewId === "")
    throw new TypeError("registerBasesView: the view id must be a non-empty string");
  if (!reg || typeof reg.name !== "string" || typeof reg.factory !== "function")
    throw new TypeError("registerBasesView: a registration needs a name and a factory function");
  const full: Registration = {
    name: reg.name,
    icon: typeof reg.icon === "string" ? reg.icon : "layout-grid",
    factory: reg.factory as Factory,
    options: reg.options,
  };
  const removed = registerBaseView({
    type: viewId,
    name: full.name,
    icon: full.icon,
    owner: pluginId,
    mount: (container, props) => new PluginViewInstance(app, pluginId, full, container, props),
    options: (view) => {
      if (!full.options) return [];
      try {
        // Option declarations only read `config.get` and friends, so a config over the view alone
        // is enough here (the live view gets the full one).
        const config = new BasesViewConfig(() => ({
          view,
          document: null,
          result: null,
          config: null,
        }));
        return adaptOptions(full.options(config));
      } catch (e) {
        console.error(`[plugin] ${pluginId} options() failed:`, e);
        recordPluginError(pluginId, "bases-view:options", e);
        return [];
      }
    },
  });
  return removed !== null;
}
