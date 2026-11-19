// Context-menu items contributed by features: one registry, the surface is part of the key. A
// surface builder asks for the items of its surface and appends them where it says
// (docs/consolidation.md: registry over per-case branches). Surfaces and what each hands the
// feature are `MenuSurfaces` in `types.ts`; a surface joins by adding a key there and one
// `contributedMenuItems` call in its builder.
import type { MenuItemSpec } from "@/components/editor-area/editor-context-menu";
import { reportOwnerFailure } from "./health";
import { withFeatureDivider } from "./origin";
import { OwnedRegistry } from "@/lib/owned-registry";
import type { MenuGroup, MenuSurface, MenuSurfaces } from "./types";

export interface OwnedMenuContribution {
  owner: string;
  surface: MenuSurface;
  /** `<feature id>.<name>`. */
  id: string;
  /** The arguments are the surface's (`MenuSurfaces`); `contributedMenuItems` is the typed caller. */
  items: (...args: never[]) => MenuItemSpec[] | Promise<MenuItemSpec[]>;
  group?: MenuGroup;
}

export const menuContributions = new OwnedRegistry<OwnedMenuContribution>();

/** Registry key: the same id may appear on two surfaces. */
export const menuKey = (surface: MenuSurface, id: string) => `${surface}:${id}`;

/** The contributed items of `surface` that go after the core items (group `end`), in registration
 *  order; a failing contribution is logged, counted against its feature and skipped. */
export function contributedMenuItems<S extends MenuSurface>(
  surface: S,
  ...args: MenuSurfaces[S]
): Promise<MenuItemSpec[]> {
  return collect(surface, "end", args);
}

/** The contributed "New …" items of `surface` (group `create`), for a surface that shows them next
 *  to its own New Note / New Folder. */
export function contributedCreateItems<S extends MenuSurface>(
  surface: S,
  ...args: MenuSurfaces[S]
): Promise<MenuItemSpec[]> {
  return collect(surface, "create", args);
}

async function collect<S extends MenuSurface>(
  surface: S,
  group: MenuGroup,
  args: MenuSurfaces[S],
): Promise<MenuItemSpec[]> {
  const parts = await Promise.all(
    menuContributions
      .list()
      .filter((c) => c.surface === surface && (c.group ?? "end") === group)
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

/** `spec` followed by a separator and `extra` (the one feature-after-core rule, `origin.ts`), or
 *  `spec` alone when there is no extra item. A separator already ending `spec` is reused, never
 *  doubled. */
export function withContributedItems<T extends MenuItemSpec>(
  spec: readonly T[],
  extra: readonly MenuItemSpec[],
): Array<T | MenuItemSpec> {
  let end = spec.length;
  while (end > 0 && spec[end - 1]!.kind === "separator") end--;
  return withFeatureDivider<T | MenuItemSpec, MenuItemSpec>(spec.slice(0, end), extra, {
    kind: "separator",
  });
}
