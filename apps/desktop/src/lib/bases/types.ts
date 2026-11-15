// Contract types of the Bases backend. The Rust side owns the shapes:
// `BaseQueryResult` and friends are the serde structs in
// `src-tauri/src/bases/query.rs`, `Value::to_json` in `value.rs` is the tagged
// value form, and `Document` in `document.rs` is the parsed `.base` model.
// This file is the one TypeScript mirror of them; nothing else declares these
// shapes.

/** A Bases value in its tagged JSON form (`Value::to_json`). */
export type CellValue =
  | { type: "null" }
  | { type: "boolean"; value: boolean }
  /** `value` is `null` for NaN / infinity (JSON has no such number). */
  | { type: "number"; value: number | null }
  | { type: "string"; value: string }
  | { type: "html"; value: string }
  | { type: "image"; value: string }
  | { type: "icon"; value: string }
  /** `value` is an ISO string: `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm:ss...`. */
  | { type: "date"; value: string; hasTime: boolean }
  | { type: "duration"; value: { months: number; millis: number } }
  | { type: "list"; value: CellValue[] }
  | { type: "object"; value: Record<string, CellValue> }
  | {
      type: "link";
      value: {
        /** Link text without brackets, heading or alias. */
        target: string;
        display: string | null;
        /** Vault-relative path the link resolves to, `null` when unresolved. */
        resolved: string | null;
      };
    }
  /** Vault-relative path. */
  | { type: "file"; value: string }
  | { type: "regexp"; value: { source: string; flags: string } }
  | { type: "error"; value: { kind: string; message: string } };

export type CellValueType = CellValue["type"];

/** A value plus the display string the engine computed for it. */
export type Cell = CellValue & { display: string };

export interface ViewInfo {
  name: string;
  type: string;
  /** Index in the document's `views`; `null` for the implicit view of a base without views. */
  index: number | null;
}

export interface Column {
  /** Property id as written in `order`. */
  id: string;
  /** Canonical key: `note.` dropped, `file.` and `formula.` kept. */
  key: string;
  displayName: string;
  /** Summary configured for this column. */
  summary: string | null;
}

export interface Row {
  /** Vault-relative path of the file. */
  path: string;
  /** One cell per column. */
  cells: Cell[];
}

export interface Group {
  key: Cell;
  /** Range of this group in the flat `rows`. */
  start: number;
  len: number;
  /** Per column, `null` where no summary is configured. */
  summaries: (Cell | null)[];
}

/** `document`: the `.base` text itself does not parse. */
export type QueryErrorKind = "viewNotFound" | "filterSyntax" | "filterEval" | "source" | "document";

/** The explicit error state of a view: shown instead of rows. */
export interface QueryError {
  kind: QueryErrorKind;
  message: string;
  /** The offending filter expression. */
  expression: string | null;
  /** The row on which evaluation failed. */
  path: string | null;
}

export interface BaseQueryResult {
  view: ViewInfo;
  /** Names of every view of the base, in file order (the view tabs). */
  availableViews: string[];
  columns: Column[];
  /** Flat rows in final order (group order when grouped, limit applied). */
  rows: Row[];
  groups: Group[] | null;
  /** Summaries over all shown rows, aligned with `columns`. */
  summaries: (Cell | null)[];
  /** Rows that passed the filters, before `limit`. */
  totalMatched: number;
  error: QueryError | null;
  warnings: string[];
}

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

export interface BaseFileEntry {
  /** Vault-relative path. */
  path: string;
  name: string;
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

export interface NoteProperties {
  /** Top-level frontmatter keys, plain JSON. Empty when there is no frontmatter. */
  properties: Record<string, unknown>;
  /** Key names in file order. */
  order: string[];
  /** Index type per key: `text`, `number`, `bool`, `date`, `datetime`, `list`, `link`, `object`, `null`. */
  types: Record<string, string>;
  /** Set when the frontmatter does not parse; the note's properties are then read-only. */
  error: string | null;
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

/** One entry of the engine's function registry (`base_functions`, Rust `FunctionInfo`). */
export interface BaseFunctionInfo {
  name: string;
  /** `global` for `date(...)`, `method` for `x.slice(...)`. */
  kind: "global" | "method";
  /** `["global"]`, `["any"]`, or the receiver type names (`string`, `list`, ...). */
  receivers: string[];
  /** For example `string.slice(start, end?): string`. */
  signature: string;
  doc: string;
  /** Return type name (`any` when the signature names none). */
  returns: string;
  minArgs: number;
  /** `null` for a variadic function. */
  maxArgs: number | null;
}
