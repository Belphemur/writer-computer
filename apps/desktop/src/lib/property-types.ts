// Property types in the frontend: the one registry (id, label, icon, warning text), the typed
// client state shape, and the pure rules that relate a parsed row to a type. The record of which
// name has which type lives in Rust (`src-tauri/src/property_types.rs`: `.writer/property-types.json`
// over a read-only `.obsidian/types.json`, else inferred); this module never stores a type.
import {
  Alert02Icon,
  AtIcon,
  BracesIcon,
  Calendar03Icon,
  CheckmarkSquare02Icon,
  Clock01Icon,
  DropdownFieldTypeIcon,
  HashtagIcon,
  LeftToRightListBulletIcon,
  Link01Icon,
  Tag01Icon,
  TextIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { type PropertyKind, type PropertyRow } from "./frontmatter-properties";
import { isWikiLink } from "./wiki-links";

/** Obsidian's names (`types.json` values), also the wire names with the backend, plus Writer's own
 *  `relationships` (a link or a list of links), `enum` (one string of a recorded list) and `object`
 *  (a map edited as indented rows). Obsidian has none of them, so they live only in
 *  `.writer/property-types.json` (`writerOnly`) and plugins see them as `multitext` / `text`. */
export type PropertyType =
  | "text"
  | "multitext"
  | "number"
  | "checkbox"
  | "date"
  | "datetime"
  | "tags"
  | "aliases"
  | "relationships"
  | "enum"
  | "object";

interface TypeDefinition {
  label: string;
  icon: IconSvgElement;
  /** Shown inline when a value does not fit the type. */
  warning: string;
  /** Offered in the type menu (tags and aliases are special names, shown only when current). */
  pickable: boolean;
  /** Obsidian has no such type: recorded only in Writer's file, never assignable by a plugin. */
  writerOnly?: boolean;
}

/** The registry: a new type is one entry here (and one in the Rust enum). */
export const PROPERTY_TYPES: Record<PropertyType, TypeDefinition> = {
  text: { label: "Text", icon: TextIcon, warning: "Not text", pickable: true },
  multitext: {
    label: "List",
    icon: LeftToRightListBulletIcon,
    warning: "Not a list",
    pickable: true,
  },
  relationships: {
    label: "Relationships",
    icon: Link01Icon,
    warning: "Not a link",
    pickable: true,
    writerOnly: true,
  },
  enum: {
    label: "Enum",
    icon: DropdownFieldTypeIcon,
    warning: "Not text",
    pickable: true,
    writerOnly: true,
  },
  object: {
    label: "Object",
    icon: BracesIcon,
    warning: "Not an object",
    pickable: true,
    writerOnly: true,
  },
  number: { label: "Number", icon: HashtagIcon, warning: "Not a number", pickable: true },
  checkbox: {
    label: "Checkbox",
    icon: CheckmarkSquare02Icon,
    warning: "Not true or false",
    pickable: true,
  },
  date: { label: "Date", icon: Calendar03Icon, warning: "Not a date", pickable: true },
  datetime: {
    label: "Date & time",
    icon: Clock01Icon,
    warning: "Not a date and time",
    pickable: true,
  },
  tags: { label: "Tags", icon: Tag01Icon, warning: "Not a list of tags", pickable: false },
  aliases: { label: "Aliases", icon: AtIcon, warning: "Not a list of aliases", pickable: false },
};

/** Icon of the unknown/mixed state: the value does not fit the declared type. */
export const MISMATCH_ICON: IconSvgElement = Alert02Icon;

export const PROPERTY_TYPE_IDS = Object.keys(PROPERTY_TYPES) as PropertyType[];

/** One vault property as the backend reports it (`property_types`). */
export interface PropertyTypeInfo {
  key: string;
  /** Notes defining the property. */
  count: number;
  /** Observed value types with note counts. */
  types: Record<string, number>;
  type: PropertyType;
  source: "writer" | "obsidian" | "inferred";
  /** Notes whose value does not fit `type`. */
  mismatched: number;
  /** The type name Obsidian and its plugins know this one by (Rust `PropertyType::obsidian_name`):
   *  `relationships` is `multitext` when the vault holds lists of links there, else `text`. */
  obsidianType: string;
  /** An enum's allowed values, in order (empty for any other type). */
  values: string[];
}

/** Name -> info lookups are case-insensitive, like Obsidian's `types.json`. */
export function typeKey(name: string): string {
  return name.trim().toLowerCase();
}

/** The types the menu lists: the pickable ones, plus the current one when it is special. */
export function menuTypes(current: PropertyType): PropertyType[] {
  return PROPERTY_TYPE_IDS.filter((t) => PROPERTY_TYPES[t].pickable || t === current);
}

/** The type a row's own value suggests (used until the name has a recorded or vault type). */
export function typeOfRow(row: PropertyRow): PropertyType {
  switch (row.kind) {
    case "number":
      return "number";
    case "checkbox":
      return "checkbox";
    case "date":
      return "date";
    case "datetime":
      return "datetime";
    case "tags":
    case "tagString":
      return "tags";
    case "list":
      if (row.key.toLowerCase() === "aliases") return "aliases";
      return isLinkList(row) ? "relationships" : "multitext";
    case "link":
      return "relationships";
    case "object":
      return "object";
    default:
      return "text";
  }
}

/** A non-empty list whose every item is a `[[wikilink]]`. */
function isLinkList(row: PropertyRow): boolean {
  return row.kind === "list" && row.items.length > 0 && row.items.every(isWikiLink);
}

const FITS: Record<PropertyType, readonly PropertyKind[]> = {
  text: ["text", "link", "url", "multiline"],
  number: ["number"],
  checkbox: ["checkbox"],
  date: ["date"],
  datetime: ["datetime"],
  multitext: ["list", "tags"],
  tags: ["tags", "tagString", "list"],
  aliases: ["list", "tags"],
  // a single link; a list of links is checked by items in `rowFitsType`
  relationships: ["link"],
  // the dropdown edits a text value; anything else keeps its own editor and shows the warning
  enum: ["text"],
  object: ["object"],
};

/** Whether the row's value is a valid value of `type`. An empty value fits every type; a value
 *  the panel cannot interpret (an alias) fits none. */
export function rowFitsType(row: PropertyRow, type: PropertyType): boolean {
  if (row.kind === "empty") return true;
  if (type === "relationships" && row.kind === "list") return row.items.every(isWikiLink);
  return FITS[type].includes(row.kind);
}
