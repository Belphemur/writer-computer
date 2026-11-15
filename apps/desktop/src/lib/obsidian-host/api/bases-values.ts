// The `Value` classes of the public Bases plugin API (`obsidian.d.ts`: `Value`, `NullValue`,
// `BooleanValue`, `NumberValue`, `StringValue`, `DateValue`, `ListValue`, `ObjectValue`,
// `LinkValue`, `UrlValue`, `FileValue`, `HTMLValue`, `ImageValue`, `IconValue`, `RegExpValue`,
// `ErrorValue`, ...). Plugins receive instances from `BasesEntry.getValue(id)`; they are built
// here from the engine's tagged values (`CellValue`), so plugin code and the built-in views read
// one model: the display text is the engine's, never recomputed.
import type { CellValue } from "@/lib/bases/types";

export abstract class Value {
  /** Display text (what a table cell shows). */
  abstract toString(): string;
  isTruthy(): boolean {
    return true;
  }
  /** Same class and same display text. */
  equals(other: Value): boolean {
    return (
      other instanceof Value &&
      other.constructor === this.constructor &&
      other.toString() === this.toString()
    );
  }
  /** Rendered as text only: never as HTML, whatever the value holds. */
  renderTo(el: HTMLElement, _ctx?: unknown): void {
    el.textContent = this.toString();
  }
  static equals(a: Value | null | undefined, b: Value | null | undefined): boolean {
    if (!a || !b) return !a && !b;
    return a.equals(b);
  }
}

export class NullValue extends Value {
  static value: NullValue = new NullValue();
  toString(): string {
    return "";
  }
  isTruthy(): boolean {
    return false;
  }
  equals(other: Value): boolean {
    return other instanceof NullValue;
  }
}

/** A value wrapping one JS primitive in `.value`. */
export class PrimitiveValue<T> extends Value {
  constructor(
    public value: T,
    protected display?: string,
  ) {
    super();
  }
  toString(): string {
    return this.display ?? String(this.value);
  }
  isTruthy(): boolean {
    return Boolean(this.value);
  }
  equals(other: Value): boolean {
    return (
      other instanceof PrimitiveValue &&
      other.constructor === this.constructor &&
      other.value === this.value
    );
  }
}

export class BooleanValue extends PrimitiveValue<boolean> {}
export class NumberValue extends PrimitiveValue<number> {
  isTruthy(): boolean {
    return this.value !== 0 && !Number.isNaN(this.value);
  }
}
export class StringValue extends PrimitiveValue<string> {
  isTruthy(): boolean {
    return this.value !== "";
  }
}
export class UrlValue extends StringValue {}
export class HTMLValue extends StringValue {
  /** Text only: HTML from a note or formula is never injected. */
  renderTo(el: HTMLElement): void {
    el.textContent = this.value;
  }
}
export class ImageValue extends StringValue {}
export class IconValue extends StringValue {}
export class FileValue extends StringValue {}

export class LinkValue extends StringValue {
  constructor(
    /** Link text without brackets, heading or alias. */
    public target: string,
    public displayText: string | null = null,
    /** Vault-relative path the link resolves to, `null` when it does not. */
    public path: string | null = null,
    display?: string,
  ) {
    super(displayText ?? target, display);
  }
}

export class DateValue extends Value {
  constructor(
    public date: Date,
    /** The value carries a time of day. */
    public time: boolean,
    private display?: string,
  ) {
    super();
  }
  toString(): string {
    return (
      this.display ?? (this.time ? this.date.toISOString() : this.date.toISOString().slice(0, 10))
    );
  }
  equals(other: Value): boolean {
    return other instanceof DateValue && other.date.getTime() === this.date.getTime();
  }
}

export class DurationValue extends Value {
  constructor(
    public months: number,
    public millis: number,
    private display?: string,
  ) {
    super();
  }
  toString(): string {
    return this.display ?? `${this.months}M ${this.millis}ms`;
  }
}

export class RegExpValue extends Value {
  constructor(
    public source: string,
    public flags: string,
  ) {
    super();
  }
  toString(): string {
    return `/${this.source}/${this.flags}`;
  }
}

export class ListValue extends Value {
  constructor(
    public value: Value[],
    private display?: string,
  ) {
    super();
  }
  length(): number {
    return this.value.length;
  }
  get(index: number): Value {
    return this.value[index] ?? NullValue.value;
  }
  toString(): string {
    return this.display ?? this.value.map((v) => v.toString()).join(", ");
  }
  isTruthy(): boolean {
    return true;
  }
  equals(other: Value): boolean {
    return (
      other instanceof ListValue &&
      other.value.length === this.value.length &&
      this.value.every((v, i) => v.equals(other.value[i]!))
    );
  }
}

export class ObjectValue extends Value {
  constructor(
    public value: Record<string, Value>,
    private display?: string,
  ) {
    super();
  }
  get(key: string): Value {
    return this.value[key] ?? NullValue.value;
  }
  keys(): string[] {
    return Object.keys(this.value);
  }
  toString(): string {
    return (
      this.display ??
      JSON.stringify(
        Object.fromEntries(Object.entries(this.value).map(([k, v]) => [k, v.toString()])),
      )
    );
  }
}

export class ErrorValue extends Value {
  constructor(
    public message: string,
    public kind = "Error",
  ) {
    super();
  }
  toString(): string {
    return `Error: ${this.message}`;
  }
  isTruthy(): boolean {
    return false;
  }
}

/** Local-naive date from the engine's ISO string (`YYYY-MM-DD` or `YYYY-MM-DDTHH:mm:ss...`). */
function parseLocalDate(iso: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?/.exec(iso);
  if (!m) return new Date(iso);
  return new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4] ?? 0),
    Number(m[5] ?? 0),
    Number(m[6] ?? 0),
    m[7] ? Number(m[7].padEnd(3, "0").slice(0, 3)) : 0,
  );
}

/** The plugin-facing `Value` of an engine value; `display` is the engine's display string. */
export function toValue(cell: CellValue & { display?: string }): Value {
  const d = cell.display;
  switch (cell.type) {
    case "null":
      return NullValue.value;
    case "boolean":
      return new BooleanValue(cell.value, d);
    case "number":
      return new NumberValue(cell.value ?? Number.NaN, d);
    case "string":
      return new StringValue(cell.value, d);
    case "html":
      return new HTMLValue(cell.value, d);
    case "image":
      return new ImageValue(cell.value, d);
    case "icon":
      return new IconValue(cell.value, d);
    case "date":
      return new DateValue(parseLocalDate(cell.value), cell.hasTime, d);
    case "duration":
      return new DurationValue(cell.value.months, cell.value.millis, d);
    case "list":
      return new ListValue(
        cell.value.map((c) => toValue(c)),
        d,
      );
    case "object":
      return new ObjectValue(
        Object.fromEntries(Object.entries(cell.value).map(([k, v]) => [k, toValue(v)])),
        d,
      );
    case "link":
      return new LinkValue(cell.value.target, cell.value.display, cell.value.resolved, d);
    case "file":
      return new FileValue(cell.value, d);
    case "regexp":
      return new RegExpValue(cell.value.source, cell.value.flags);
    case "error":
      return new ErrorValue(cell.value.message, cell.value.kind);
  }
}
