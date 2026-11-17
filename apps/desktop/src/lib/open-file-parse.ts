import { parseDocument, type ParsedDocument } from "@/lib/frontmatter";
import { isCodePath } from "@/lib/code-files";

/**
 * The editor store's one way to split raw file text into frontmatter and body. A code file is
 * all body: a `---` at the top of a YAML file is not note frontmatter, and a code file has no
 * title override.
 */
export function parseOpenedFile(path: string, raw: string): ParsedDocument {
  if (isCodePath(path)) return { frontmatter: null, body: raw, title: "", titleSource: "none" };
  return parseDocument(raw);
}
