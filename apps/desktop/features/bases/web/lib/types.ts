// Contract types of the Bases backend. The Rust side owns the shapes: `BaseQueryResult` and
// friends are the serde structs in `src-tauri/src/bases/query.rs`, `Value::to_json` in `value.rs`
// is the tagged value form (described for typegen by `bases/wire.rs`), and `Document` in
// `document.rs` is the parsed `.base` model. The query shapes are generated (`bindings.ts`,
// re-exported by `ipc.ts`, the one importer of that file); the `.base` document model below is the
// one hand-kept mirror, and nothing else declares these shapes.

import type {
  BaseListEntry,
  BaseQueryResult,
  CellValueWire,
  CellWire,
  Column,
  FunctionInfo,
  Group,
  NoteProperties,
  QueryError,
  QueryErrorKind,
  Row,
  ViewInfo,
} from "../ipc";

// The wire shapes of the query (`BaseQueryResult` and everything inside it), the cell values and
// the function registry are generated from the Rust structs (`bindings.ts`, tauri-specta) and only
// named here. What is written below them is hand-kept: the `.base` document (Rust serializes
// `Document` as free-form JSON) and the argument shapes the UI builds.
export type {
  BaseQueryResult,
  Column,
  Group,
  NoteProperties,
  QueryError,
  QueryErrorKind,
  Row,
  ViewInfo,
};

/** A Bases value in its tagged JSON form (`Value::to_json`; `bases/wire.rs`). */
export type CellValue = CellValueWire;

export type CellValueType = CellValue["type"];

/** A value plus the display string the engine computed for it. */
export type Cell = CellWire;

/** One entry of the engine's function registry (`base_functions`, Rust `FunctionInfo`). */
export type BaseFunctionInfo = FunctionInfo;

export type BaseFileEntry = BaseListEntry;

// ---------------------------------------------------------------------------
// `.base` document (`Document::to_json` shape, camelCase)
// ---------------------------------------------------------------------------

export type SortDirection = "ASC" | "DESC";

export interface BaseSortKey {
  property: string;
  direction: SortDirection;
}

export interface BaseGroupBy {
  property: string;
  direction: SortDirection;
}

/** A filter tree as in the `.base` file: an expression string or an and/or/not group. */
export type BaseFilter =
  | string
  | { and: BaseFilter[] }
  | { or: BaseFilter[] }
  | { not: BaseFilter[] };

export interface BaseView {
  type: string;
  name: string;
  /** The view's own filters (ANDed with the base-level ones); `null` when absent. */
  filters: BaseFilter | null;
  groupBy: BaseGroupBy | null;
  /** Manual group order: entries first in this order, the rest sorted. `null` when absent. */
  groupOrder?: unknown[] | null;
  sort: BaseSortKey[];
  order: string[] | null;
  limit: number | null;
  /** Property id as written -> width in px. */
  columnSize: Record<string, unknown>;
  /** Property id as written -> summary name. */
  summaries: Record<string, string>;
  /** Unknown keys, kept verbatim (`rowHeight`, `cardSize`, plugin options). */
  extra: Record<string, unknown>;
}

export interface BasePropertyConfig {
  displayName: string | null;
}

export interface BaseDocument {
  name: string | null;
  /** Base-level filters; `null` when absent. */
  filters: BaseFilter | null;
  formulas: Record<string, string>;
  properties: Record<string, BasePropertyConfig>;
  summaries: Record<string, string>;
  views: BaseView[];
  /** Model-level warnings (an entry that did not fit the model was kept verbatim). */
  warnings: string[];
}

export interface BaseReadResult {
  /** Raw `.base` text, byte for byte. */
  text: string;
  /** `null` when the text does not parse; `error` then says why. */
  document: BaseDocument | null;
  error: string | null;
}

/** `base_parse_text`: `document` is `null` when the text does not parse; `error` then says why. */
export interface BaseParsedResult {
  document: BaseDocument | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export interface BaseQueryArgs {
  /** Workspace path of the `.base` file (absolute, or vault-relative). */
  path: string;
  /** View name; the first view when omitted. */
  view?: string;
  /** The `this` file (the base itself when opened in a tab). */
  thisPath?: string;
  /** Minutes east of UTC of the viewer's clock, for `today()` / `now()`. */
  nowOffsetMinutes?: number;
}

export interface BaseQueryTextArgs extends Omit<BaseQueryArgs, "path"> {
  text: string;
}

/** `valueType` tells the backend how to write a value YAML-style (`ValueType::parse` in Rust). */
export type PropertyValueType = "text" | "number" | "checkbox" | "date" | "datetime" | "list";

/** JSON value written to / read from a note's frontmatter. */
export type PropertyJson = string | number | boolean | null | PropertyJson[];

export interface NotePropertySetArgs {
  path: string;
  name: string;
  value: PropertyJson;
  valueType?: PropertyValueType;
}

export interface NotePropertyRemoveArgs {
  path: string;
  name: string;
}

/** `index://changed` payload. */
export interface IndexChangedEvent {
  epoch: number;
  root: string;
  /** Vault-relative paths written or removed. Empty with `full` set. */
  paths: string[];
  full: boolean;
}

/** One vault property from the index (`index_properties`). */
export interface VaultProperty {
  key: string;
  count: number;
  types: Record<string, number>;
}

export interface BaseEvalArgs {
  expression: string;
  /** The `this` file (and current row). */
  thisPath: string;
  nowOffsetMinutes?: number;
  /** `.base` source whose `formulas` the expression may reference. */
  text?: string;
}
