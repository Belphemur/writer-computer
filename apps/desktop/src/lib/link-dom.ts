// The class names of rendered links: the contract between the code that writes the link DOM
// (CodeMirror decorations, table cells) and the code that reads it (activation handlers, table
// hit-testing). One definition; nothing else spells these strings.

export const RENDERED_LINK_CLASS = "cm-rendered-link";
export const WIKI_LINK_CLASS = "cm-wiki-link";
/** Matches an element inside either kind of rendered link (`closest(LINK_SELECTOR)`). */
export const LINK_SELECTOR = `.${RENDERED_LINK_CLASS}, .${WIKI_LINK_CLASS}`;
