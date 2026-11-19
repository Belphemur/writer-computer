// Writing the note's language into its front matter: the one edit the language menu makes on
// confirm. Pure text in, one CodeMirror change out, so the editor stays the source of truth and
// the note is saved the way every other edit is.

export interface TextChange {
  from: number;
  to: number;
  insert: string;
}

const KEY = /^(lang|language)\s*:/;

/** The change that makes `lang: <tag>` the note's language property: it replaces an existing
 *  `lang:` or `language:` line, adds a line to existing front matter, or creates the block. */
export function languagePropertyChange(text: string, tag: string): TextChange {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trimEnd() === "---") {
    let offset = lines[0].length + eol.length;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.trimEnd() === "---" || line.trimEnd() === "...") {
        // no language line before the end of the block: add one just above it
        return { from: offset, to: offset, insert: `lang: ${tag}${eol}` };
      }
      if (KEY.test(line)) {
        return { from: offset, to: offset + line.length, insert: `lang: ${tag}` };
      }
      offset += line.length + eol.length;
    }
    // an unclosed `---` is not front matter: fall through and create a block
  }
  return { from: 0, to: 0, insert: `---${eol}lang: ${tag}${eol}---${eol}${eol}` };
}
