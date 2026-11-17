import { getBaseView } from "../lib/view-registry";
import type { ViewConfig } from "../lib/view-registry";
import { FilterMenu } from "./filter-menu";
import type { MenuContext } from "./menu-context";
import { PropertiesMenu } from "./properties-menu";
import { ResultsMenu } from "./results-menu";
import { GroupMenu, SortMenu } from "./sort-group-menus";
import { ViewMenu } from "./view-menu";
import { ViewSettings } from "./view-settings";

/** The toolbar menus of the selected view. They only edit the file through `ctx.apply`. */
export function ConfigMenus({ ctx, config }: { ctx: MenuContext; config: ViewConfig }) {
  const entry = getBaseView(ctx.view.type);
  const options = entry?.options?.(ctx.view) ?? [];
  return (
    <>
      <ViewMenu ctx={ctx} />
      <ResultsMenu ctx={ctx} />
      <SortMenu ctx={ctx} />
      <GroupMenu ctx={ctx} />
      <FilterMenu ctx={ctx} />
      <PropertiesMenu ctx={ctx} />
      {entry ? <ViewSettings ctx={ctx} options={options} config={config} /> : null}
    </>
  );
}
