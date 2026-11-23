// The class names of rendered links: the contract between the code that writes the link DOM
// (CodeMirror decorations, table cells) and the code that reads it (activation handlers, table
// hit-testing). One definition; nothing else spells these strings.

export const RENDERED_LINK_CLASS = "cm-rendered-link";
export const WIKI_LINK_CLASS = "cm-wiki-link";
/** The icon of the note a rendered link points to, inside the link (`lib/file-icons.ts`). */
export const LINK_ICON_CLASS = "cm-link-icon";
/** Matches an element inside either kind of rendered link (`closest(LINK_SELECTOR)`). */
export const LINK_SELECTOR = `.${RENDERED_LINK_CLASS}, .${WIKI_LINK_CLASS}`;

/** A body `#tag` shown as a pill in the editor (`data-tag` holds the normalised tag). Not a
 *  rendered link for `LINK_SELECTOR`: it opens search, not a file. */
export const TAG_PILL_CLASS = "cm-tag-pill";
