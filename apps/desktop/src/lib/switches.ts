/**
 * The one rule of the on/off lists the agent keeps (models switched off, MCP servers switched off
 * or on): a list holds the names that differ from the default (`defaultOn`: the listed ones are
 * off; otherwise the listed ones are on). Rust twin: `Switches` in
 * `src-tauri/src/agent/mcp_menu.rs`; both read `shared/agent-mcp/vectors.json`.
 */

/** Whether `name` is on under the stored `list` (exact names: model ids). */
export const isSwitchOn = (list: readonly string[], name: string, defaultOn: boolean): boolean =>
  defaultOn !== list.includes(name);

/** The list after switching `name` on or off: no duplicates, the others in their order. */
export function switchedAfter(
  list: readonly string[],
  name: string,
  on: boolean,
  defaultOn: boolean,
): string[] {
  const rest = list.filter((x) => x !== name);
  return on === defaultOn ? rest : [...rest, name];
}

/** The one name every harness knows an MCP server by: each character outside `[A-Za-z0-9_-]`
 *  becomes `_`. Rust twin: `mcp_wiring::server_key`. */
export const serverKey = (raw: string): string => raw.replace(/[^A-Za-z0-9_-]/gu, "_");

/** Whether the stored `list` names the server `name`: by key (`my.srv` is `my_srv`), or, where the
 *  list holds the servers switched off (`defaultOn`), by the tool glob a name stands for (`a` covers
 *  `a__b`). A list of servers switched on covers only its own keys: `a` on never turns `a__b` on.
 *  Rust twin: `Switches::listed`. */
function mcpListed(list: readonly string[], name: string, defaultOn: boolean): boolean {
  const key = serverKey(name);
  return list.some((entry) => key === serverKey(entry) || (defaultOn && coveringKey(entry, key)));
}

/** Whether the stored `entry` is a glob that covers the server `key` (`a` covers `a__b`). */
const coveringKey = (entry: string, key: string): boolean => {
  const k = serverKey(entry);
  return key !== k && key.startsWith(k) && key.slice(k.length).startsWith("__");
};

/** The key of the entry that switches `name` off without being its own (`a` for `a__b`), or null.
 *  Only where the list holds the servers switched off: there a covered row is not its own to
 *  switch (switching it on would take its parent's entry away). */
export function mcpCoveredBy(
  list: readonly string[],
  name: string,
  defaultOn: boolean,
): string | null {
  if (!defaultOn) return null;
  const key = serverKey(name);
  const entry = list.find((e) => coveringKey(e, key));
  return entry === undefined ? null : serverKey(entry);
}

/** [`isSwitchOn`] for MCP servers, whose stored names may be raw and may be globs. */
export const isMcpSwitchOn = (list: readonly string[], name: string, defaultOn: boolean): boolean =>
  defaultOn !== mcpListed(list, name, defaultOn);

/** [`switchedAfter`] for MCP servers: unchanged when already as asked, else the name added or every
 *  entry that names it removed. */
export function mcpSwitchedAfter(
  list: readonly string[],
  name: string,
  on: boolean,
  defaultOn: boolean,
): string[] {
  if (isMcpSwitchOn(list, name, defaultOn) === on) return [...list];
  if (on !== defaultOn) return [...list, name];
  const key = serverKey(name);
  return list.filter((entry) => !mcpListed([entry], key, defaultOn));
}
