// Option controls of a view (the view-settings popover). One shape for built-in views and for
// plugin views registered through `registerBasesView`; the public Obsidian option types
// (`dropdown`, `file`, `folder`, `formula`, `multitext`, `property`, `slider`, `text`, `toggle`,
// `group`) are the vocabulary. A value persists into the view's YAML entry under the option `key`.
import type { BaseView } from "./types";

interface OptionBase {
  displayName: string;
  /** Property of the view's YAML entry holding the value. */
  key: string;
}

export type ViewOption =
  | (OptionBase & { type: "dropdown"; default?: string; options: Record<string, string> })
  | (OptionBase & { type: "text"; default?: string; placeholder?: string })
  | (OptionBase & { type: "multitext"; default?: string[] })
  | (OptionBase & { type: "toggle"; default?: boolean })
  | (OptionBase & { type: "slider"; default?: number; min: number; max: number; step: number })
  | (OptionBase & { type: "property"; default?: string; placeholder?: string })
  | (OptionBase & { type: "formula"; default?: string; placeholder?: string })
  | (OptionBase & { type: "file"; default?: string; placeholder?: string })
  | (OptionBase & { type: "folder"; default?: string; placeholder?: string })
  | { type: "group"; displayName: string; items: ViewOption[]; key?: undefined };

export type ValueOption = Exclude<ViewOption, { type: "group" }>;

/** Every value-carrying option, groups flattened. */
export function flattenOptions(options: readonly ViewOption[]): ValueOption[] {
  return options.flatMap((o) => (o.type === "group" ? flattenOptions(o.items) : [o]));
}

/** The stored value of an option (`undefined` when the view's YAML has none). */
export function optionValue(view: BaseView | undefined, option: ValueOption): unknown {
  return view?.extra[option.key];
}

/** The stored value, else the option's default. */
export function optionValueOrDefault(view: BaseView | undefined, option: ValueOption): unknown {
  return optionValue(view, option) ?? option.default;
}

/** Property ids a view's options point at (`property` options), for `extraProperties`. */
export function propertyOptionValues(
  view: BaseView | undefined,
  options: readonly ViewOption[],
): string[] {
  const out: string[] = [];
  for (const o of flattenOptions(options)) {
    if (o.type !== "property") continue;
    const v = optionValue(view, o);
    if (typeof v === "string" && v !== "") out.push(v);
  }
  return out;
}
