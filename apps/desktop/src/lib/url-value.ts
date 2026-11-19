// What counts as a URL property value (spec: `SPECs/properties-types-spec.md` "URL"): the one
// predicate of the TypeScript side, the twin of `src-tauri/src/url_value.rs`; both tests read
// `shared/url-vectors.json`. Pure: a value is never rewritten, only judged and, to open it,
// turned into an address.
//
// With no whitespace or control character anywhere, a URL is an address of a scheme Writer hands
// to the system browser (`shared/external-protocols.json`, see `lib/external-url.ts`: an
// authority scheme needs a non-empty host after `//`, the mail scheme needs `local@domain`) or a
// bare domain (ASCII labels, a TLD of 2+ letters, optional port and path) opened as https, unless
// the whole value is `name.ext` of a vault file (`notes.md`, `photo.png`): a file name, not a domain.
// Anything else (`javascript:`, `ftp:`, `file:`) is not a URL.
import attachments from "@shared/attachments.json";
import codeFiles from "@shared/code-files.json";
import vaultFiles from "@shared/vault-file-extensions.json";
import { externalSchemeOf } from "./external-url";

// A bare `name.ext` of a vault file (a note, an image, a base, ...) is a file name, not a domain.
const FILE_EXTENSIONS: ReadonlySet<string> = new Set(
  [
    ...attachments.importExtensions,
    ...attachments.renderExtensions,
    ...codeFiles.neverExtensions,
    ...vaultFiles.extensions,
  ].map((e) => e.toLowerCase()),
);
const isFileName = (v: string) =>
  !/[/?#:]/.test(v) &&
  !/^www\./i.test(v) &&
  FILE_EXTENSIONS.has(v.slice(v.lastIndexOf(".") + 1).toLowerCase());

const BLANK = /\s/;
const hasBlankOrControl = (v: string) =>
  BLANK.test(v) || [...v].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);
const BARE_DOMAIN =
  /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::[0-9]{1,5})?(?:[/?#]\S*)?$/i;
const MAIL_ADDRESS = /^[^@?]+@[^@?]+(?:\?.*)?$/;

/** The address to hand to the system browser for `value`, or null when it is not a URL. A bare
 *  domain gains `https://`; any other URL is returned as written. */
export function urlHref(value: string): string | null {
  if (value === "" || hasBlankOrControl(value)) return null;
  const known = externalSchemeOf(value);
  if (known) {
    const { authority, rest } = known;
    const ok = authority
      ? rest.startsWith("//") && rest.length > 2 && !"/?#".includes(rest[2]!)
      : MAIL_ADDRESS.test(rest);
    return ok ? value : null;
  }
  return BARE_DOMAIN.test(value) && !isFileName(value) ? `https://${value}` : null;
}

export function isUrl(value: string): boolean {
  return urlHref(value) !== null;
}

/** The chip text of a URL: host and path without the scheme and a leading `www.` (a mail address
 *  as written, without its scheme). A value that is no URL is shown as written. */
export function urlLabel(value: string): string {
  const href = urlHref(value);
  if (href === null) return value;
  const known = externalSchemeOf(href);
  if (known && !known.authority) return known.rest;
  const bare = known ? known.rest.slice(2) : value;
  return bare.replace(/^www\./i, "").replace(/\/$/, "");
}
