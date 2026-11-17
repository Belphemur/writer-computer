// The one allowlist of URL schemes Writer hands to the system browser: `shared/external-protocols.json`,
// which the Rust twin `plugin_env::openable_url` reads too (a test on each side pins the list).
// Pure, so any feature can import it; opening is `openExternal` in `lib/link-activation.ts`.
import external from "@shared/external-protocols.json";

/** The scheme names (`http`, `https`, `mailto`). `authority` schemes must be followed by `//`. */
export const EXTERNAL_SCHEMES: readonly string[] = external.schemes.map((s) => s.scheme);

/** The schemes with their trailing colon (`URL.protocol`). */
export const EXTERNAL_PROTOCOLS: ReadonlySet<string> = new Set(
  EXTERNAL_SCHEMES.map((s) => `${s}:`),
);

/** Schemes a plugin's rendered README or markdown may link besides the shared list: a click
 *  opens through the opener, whose capability scope is the gate. The plugin's own
 *  `shell.openExternal` stays on the shared list only (`tel:` is refused there). */
export const DOC_LINK_EXTRA_SCHEMES: readonly string[] = ["tel"];

/** Regexp alternation of the schemes a plugin-rendered document may link (no colon). */
export const DOC_LINK_SCHEMES = [...EXTERNAL_SCHEMES, ...DOC_LINK_EXTRA_SCHEMES].join("|");

/** A link that starts with one of [`DOC_LINK_SCHEMES`]. */
export const DOC_LINK_ABSOLUTE = new RegExp(`^(?:${DOC_LINK_SCHEMES}):`, "i");

/** Whether `href` starts with an allowed scheme, and `//` after it where the list demands an
 *  authority (`http:foo` and `https:/x` fail, as in Rust's `openable_url`). No URL parsing:
 *  `href` is as written. */
export const isExternalHref = (href: string | null | undefined): href is string => {
  if (!href) return false;
  const lower = href.toLowerCase();
  return external.schemes.some((s) => lower.startsWith(`${s.scheme}:${s.authority ? "//" : ""}`));
};

/** A `RegExp` accepting `href`s that start with an allowed scheme or with `#` (a sanitiser's URI
 *  allowlist for rendered markdown). */
export function externalOrAnchorUriRegExp(): RegExp {
  const schemes = [...EXTERNAL_PROTOCOLS].map((p) => p.slice(0, -1));
  return new RegExp(`^(?:(?:${schemes.join("|")}):|#)`, "i");
}
