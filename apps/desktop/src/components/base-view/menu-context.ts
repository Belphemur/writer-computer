import type { BaseDocument, BaseQueryResult, BaseView } from "@/lib/bases/types";
import type { ConfigEdit } from "./use-base-config";

/** What the toolbar menus need to read and to edit the selected view. */
export interface MenuContext {
  /** Absolute path of the `.base`. */
  path: string;
  tabId: string;
  document: BaseDocument;
  view: BaseView;
  viewIndex: number;
  result: BaseQueryResult | null;
  /** Leading columns of `result` that belong to the view's `order`. */
  shown: number;
  /** Run one `.base` edit through the write path; resolves `true` when the file changed. */
  apply: (edit: ConfigEdit) => Promise<boolean>;
  notify: (kind: "error" | "info", message: string) => void;
}
