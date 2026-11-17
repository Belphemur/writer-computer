// Context-menu items contributed by features: one registry, the surface is part of the key. A
// surface builder asks for the items of its surface and appends them where it says
// (docs/consolidation.md: registry over per-case branches). Surfaces and what each hands the
// feature are `MenuSurfaces` in `types.ts`; a surface joins by adding a key there and one
// `contributedMenuItems` call in its builder.
import type { MenuItemSpec } from "@/components/editor-area/editor-context-menu";
import { reportOwnerFailure } from "./health";
import { OwnedRegistry } from "@/lib/owned-registry";
import type { MenuSurface, MenuSurfaces } from "./types";

export interface OwnedMenuContribution {
  owner: string;
  surface: MenuSurface;
  /** `<feature id>.<name>`. */
  id: string;
  /** The arguments are the surface's (`MenuSurfaces`); `contributedMenuItems` is the typed caller. */
  items: (...args: never[]) => MenuItemSpec[] | Promise<MenuItemSpec[]>;
}

export const menuContributions = new OwnedRegistry<OwnedMenuContribution>();

/** Registry key: the same id may appear on two surfaces. */
export const menuKey = (surface: MenuSurface, id: string) => `${surface}:${id}`;

/** All contributed items of `surface` in registration order; a failing contribution is logged,
 *  counted against its feature and skipped. */
export async function contributedMenuItems<S extends MenuSurface>(
  surface: S,
  ...args: MenuSurfaces[S]
): Promise<MenuItemSpec[]> {
  const parts = await Promise.all(
    menuContributions
      .list()
      .filter((c) => c.surface === surface)
      .map(async (c) => {
        try {
          return await (
            c.items as unknown as (
              ...a: MenuSurfaces[S]
            ) => MenuItemSpec[] | Promise<MenuItemSpec[]>
          )(...args);
        } catch (e) {
          reportOwnerFailure(c.owner, "menu", e);
          return [];
        }
      }),
  );
  return parts.flat();
}

/** `spec` followed by a separator and `extra`, or `spec` alone when there is no extra item. */
export function withContributedItems<T extends MenuItemSpec>(
  spec: readonly T[],
  extra: readonly MenuItemSpec[],
): Array<T | MenuItemSpec> {
  return extra.length > 0 ? [...spec, { kind: "separator" }, ...extra] : [...spec];
}
