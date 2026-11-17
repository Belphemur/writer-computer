/** Items of an ordered contribution point (panels, toolbar buttons, footer items) by `order`,
 *  ties broken on `id`: one rule for every point that has an `order`. */
export function byOrder<T extends { order: number; id: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}
