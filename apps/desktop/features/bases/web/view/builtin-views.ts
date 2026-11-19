// The built-in view types, registered through the same function a plugin's `registerBasesView`
// ends up calling (`registerBaseView`, owner "core"). Importing this module registers them.
import { CORE_OWNER, registerBaseView } from "../lib/view-registry";
import type { ViewOption } from "../lib/view-options";
import {
  DEFAULT_CARD_SIZE,
  DEFAULT_SEPARATOR,
  MAX_ASPECT_RATIO,
  MAX_CARD_SIZE,
  MIN_ASPECT_RATIO,
  MIN_CARD_SIZE,
} from "../lib/collections";
import { ROW_HEIGHTS } from "../lib/grid";
import { CalendarView } from "./calendar-view";
import { CardsView } from "./cards-view";
import { ListView } from "./list-view";
import { TableView } from "./table-view";

const TABLE_OPTIONS: ViewOption[] = [
  {
    type: "dropdown",
    key: "rowHeight",
    displayName: "Row height",
    default: "short",
    options: Object.fromEntries(Object.keys(ROW_HEIGHTS).map((k) => [k, k])),
  },
];

const CARDS_OPTIONS: ViewOption[] = [
  {
    type: "slider",
    key: "cardSize",
    displayName: "Card size",
    default: DEFAULT_CARD_SIZE,
    min: MIN_CARD_SIZE,
    max: MAX_CARD_SIZE,
    step: 10,
  },
  { type: "property", key: "image", displayName: "Image property", placeholder: "None" },
  {
    type: "dropdown",
    key: "imageFit",
    displayName: "Image fit",
    default: "cover",
    options: { cover: "Cover", contain: "Contain" },
  },
  {
    type: "slider",
    key: "imageAspectRatio",
    displayName: "Image aspect ratio (height / width)",
    default: 1,
    min: MIN_ASPECT_RATIO,
    max: MAX_ASPECT_RATIO,
    step: 0.05,
  },
];

const LIST_OPTIONS: ViewOption[] = [
  {
    type: "dropdown",
    key: "markers",
    displayName: "Markers",
    default: "bullets",
    options: { bullets: "Bullets", numbers: "Numbers", none: "None" },
  },
  { type: "toggle", key: "indentProperties", displayName: "Indent properties", default: false },
  { type: "text", key: "separator", displayName: "Separators", default: DEFAULT_SEPARATOR },
];

const CALENDAR_OPTIONS: ViewOption[] = [
  {
    type: "property",
    key: "dateProperty",
    displayName: "Date property",
    placeholder: "Last column",
  },
];

registerBaseView({
  type: "table",
  name: "Table",
  icon: "table",
  owner: CORE_OWNER,
  Component: TableView,
  options: () => TABLE_OPTIONS,
});
registerBaseView({
  type: "cards",
  name: "Cards",
  icon: "layout-grid",
  owner: CORE_OWNER,
  Component: CardsView,
  options: () => CARDS_OPTIONS,
});
registerBaseView({
  type: "list",
  name: "List",
  icon: "list",
  owner: CORE_OWNER,
  Component: ListView,
  options: () => LIST_OPTIONS,
});
registerBaseView({
  type: "calendar",
  name: "Calendar",
  icon: "calendar",
  owner: CORE_OWNER,
  Component: CalendarView,
  options: () => CALENDAR_OPTIONS,
});
