/** What a click on a rendered README link does. Pure so it is testable. */
export type LinkAction =
  | { kind: "open"; url: string }
  | { kind: "anchor"; id: string }
  | { kind: "ignore" };

export function classifyLink(href: string | null): LinkAction {
  if (!href) return { kind: "ignore" };
  if (href.startsWith("#")) {
    let id = href.slice(1);
    try {
      id = decodeURIComponent(id);
    } catch {
      // keep the raw fragment
    }
    return id ? { kind: "anchor", id } : { kind: "ignore" };
  }
  return /^(?:https?|mailto|tel):/i.test(href) ? { kind: "open", url: href } : { kind: "ignore" };
}
