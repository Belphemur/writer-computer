import { AiBrain01Icon, Edit02Icon, Search01Icon } from "@hugeicons/core-free-icons";

/** The closed set of icon keys `shared/agent-roles.json` may name (a test ties the two): a role
 *  picks a key, this table is the only place that knows which icon it is. */
export const ROLE_ICONS = {
  search: Search01Icon,
  edit: Edit02Icon,
} as const;

/** The icon of a role key; a sub-agent type Writer does not define gets the generic one. */
export const roleIcon = (key: string | null): typeof AiBrain01Icon =>
  (key && (ROLE_ICONS as Record<string, typeof AiBrain01Icon>)[key]) || AiBrain01Icon;
