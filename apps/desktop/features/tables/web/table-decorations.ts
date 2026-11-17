import { type EditorState, type Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import { foldableSyntaxFacet } from "@/lib/prosemark-core/main";
import { SETTINGS_SCHEMA } from "@/lib/settings-schema";
import { buildTableDOM, inlineTableHost, syncTableDOM } from "./table-cells";
import { openTableFullscreen } from "./table-fullscreen";
import { isTableSource, tableSourceField } from "./table-state";
import { LINK_SELECTOR } from "@/lib/link-dom";

export { parseTableCellInlineMarkdown, type TableCellInlineNode } from "./table-inline";

const fallbackMonospaceCodeFont =
  "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace";
const codeFontFamily = `var(--pm-code-font, ${fallbackMonospaceCodeFont})`;

const tableCellLineHeight = 1.4;
const tableCellVerticalPaddingEm = 1;
const tableWidgetVerticalPaddingEm = 0.5;
const tableBorderWidthPx = 1;

function numericSettingDefault(key: string, fallback: number): number {
  const def = SETTINGS_SCHEMA.find((entry) => entry.key === key);
  return typeof def?.default === "number" ? def.default : fallback;
}

const defaultEditorFontSizePx = numericSettingDefault("editor.font-size", 16);

type Alignment = "left" | "center" | "right";

interface ParsedTable {
  headers: string[];
  alignments: (Alignment | undefined)[];
  rows: string[][];
}

function isEscapedAt(text: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) {
    backslashes++;
  }
  return backslashes % 2 === 1;
}

function parseCells(line: string): string[] {
  const trimmed = line.trim();
  const start = trimmed.startsWith("|") ? 1 : 0;
  const end =
    trimmed.endsWith("|") && !isEscapedAt(trimmed, trimmed.length - 1)
      ? trimmed.length - 1
      : trimmed.length;
  const cells: string[] = [];
  let current = "";
  let escaped = false;

  for (let i = start; i < end; i++) {
    const char = trimmed[i];
    if (char === "|" && !escaped) {
      cells.push(current.trim());
      current = "";
    } else {
      current += char;
    }
    escaped = !escaped && char === "\\";
  }

  cells.push(current.trim());
  return cells;
}

function parseAlignment(cell: string): Alignment | undefined {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return undefined;
}

function parseMarkdownTable(text: string): ParsedTable | undefined {
  const lines = text.split("\n").filter((l) => l.trim());
  if (lines.length < 2) return undefined;

  const headers = parseCells(lines[0]);
  const delimiterCells = parseCells(lines[1]);

  const isDelimiter = delimiterCells.every((c) => /^:?-+:?$/.test(c));
  if (!isDelimiter) return undefined;

  const alignments = delimiterCells.map(parseAlignment);
  const rows = lines.slice(2).map(parseCells);

  return { headers, alignments, rows };
}

function estimateTableWidgetHeight(table: ParsedTable): number {
  const visualRows = 1 + table.rows.length;
  const rowHeight = defaultEditorFontSizePx * (tableCellLineHeight + tableCellVerticalPaddingEm);
  const wrapperPadding = defaultEditorFontSizePx * tableWidgetVerticalPaddingEm;
  const horizontalBorders = Math.max(0, visualRows + 1) * tableBorderWidthPx;

  const addRowFooter = defaultEditorFontSizePx * 1.4;

  return Math.ceil(wrapperPadding + visualRows * rowHeight + horizontalBorders + addRowFooter);
}

function tableSourceLineClass(isFirst: boolean, isLast: boolean): string {
  let className = "cm-table-source-line";
  if (isFirst) className += " cm-table-source-line-first";
  if (isLast) className += " cm-table-source-line-last";
  return className;
}

function buildTableSourceLineDecorations(
  state: EditorState,
  node: { from: number; to: number },
): Range<Decoration>[] {
  const decorations: Range<Decoration>[] = [];
  const firstLine = state.doc.lineAt(node.from);

  for (let pos = firstLine.from; pos <= node.to;) {
    const line = state.doc.lineAt(pos);
    const isFirst = line.from === firstLine.from;
    const isLast = line.to >= node.to;

    decorations.push(
      Decoration.line({ class: tableSourceLineClass(isFirst, isLast) }).range(line.from),
    );

    if (isLast) break;
    pos = line.to + 1;
  }

  return decorations;
}

// --- Widget ---

class TableWidget extends WidgetType {
  constructor(
    readonly table: ParsedTable,
    readonly rawText: string,
    private readonly heightEstimate: number,
  ) {
    super();
  }

  eq(other: TableWidget): boolean {
    return this.rawText === other.rawText;
  }

  // Cells and handles handle their own events. Links keep going to the editor so a click on one
  // still follows it.
  ignoreEvent(event: Event): boolean {
    return !(event.target instanceof Element && event.target.closest(LINK_SELECTOR));
  }

  get estimatedHeight(): number {
    return this.heightEstimate;
  }

  toDOM(view: EditorView): HTMLElement {
    return buildTableDOM(this.table, (wrapper) =>
      inlineTableHost(view, wrapper, (from) => openTableFullscreen(view, from)),
    );
  }

  updateDOM(dom: HTMLElement): boolean {
    return syncTableDOM(dom, this.table);
  }
}

// --- Extensions ---

const tableFoldExtension = foldableSyntaxFacet.of({
  nodePath: "Table",
  keepDecorationOnUnfold: true,
  // A rendered table stays rendered whatever the selection does (cells are edited in place); only
  // the explicit "Edit source" toggle shows its markdown.
  buildDecorations: (state, node) => {
    const text = state.doc.sliceString(node.from, node.to);
    const parsed = parseMarkdownTable(text);
    if (!parsed) return undefined;

    if (isTableSource(state, state.doc.lineAt(node.from).from)) {
      return buildTableSourceLineDecorations(state, node);
    }

    return Decoration.replace({
      widget: new TableWidget(parsed, text, estimateTableWidgetHeight(parsed)),
      block: true,
      inclusiveStart: true,
    }).range(node.from, node.to);
  },
});

const tableTheme = EditorView.baseTheme({
  ".cm-table-source-line": {
    display: "block",
    marginLeft: "0",
    paddingLeft: "12px",
    paddingRight: "12px",
    backgroundColor: "var(--pm-code-background-color)",
    fontFamily: codeFontFamily,
    fontVariantLigatures: "none",
    fontFeatureSettings: '"calt" 0',
    fontKerning: "none",
  },
  ".cm-activeLine.cm-table-source-line": {
    backgroundColor: "var(--pm-code-background-color)",
  },
  ".cm-table-source-line-first": {
    borderTopLeftRadius: "0.4rem",
    borderTopRightRadius: "0.4rem",
  },
  ".cm-table-source-line-last": {
    borderBottomLeftRadius: "0.4rem",
    borderBottomRightRadius: "0.4rem",
  },
});

export function tableDecorations() {
  return [tableSourceField, tableFoldExtension, tableTheme];
}
