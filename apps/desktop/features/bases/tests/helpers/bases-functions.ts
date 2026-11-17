// A representative slice of the engine's function registry (`base_functions`), as the Rust
// command serializes it, plus a vault and formulas for completion tests. Synthetic data.
import type { CompletionEnv } from "../../web/lib/completion";
import type { BaseFunctionInfo } from "../../web/lib/types";

function fn(
  receivers: string[],
  name: string,
  params: string,
  returns: string,
  doc: string,
  minArgs: number,
  maxArgs: number | null,
): BaseFunctionInfo {
  const prefix = receivers.length === 1 && receivers[0] !== "global" ? `${receivers[0]}.` : "";
  const kind = receivers[0] === "global" ? "global" : "method";
  return {
    name,
    kind,
    receivers,
    signature: `${prefix}${name}(${params})${returns ? `: ${returns}` : ""}`,
    doc,
    returns: returns || "any",
    minArgs,
    maxArgs,
  };
}

export const FUNCTIONS: BaseFunctionInfo[] = [
  fn(["global"], "date", "string", "date", "Parses a date.", 1, 1),
  fn(["global"], "duration", "string", "duration", "Parses a duration.", 1, 1),
  fn(["global"], "file", "path | file | link", "file", "Returns a file.", 1, 1),
  fn(["global"], "if", "condition, trueResult, falseResult?", "", "Conditional.", 2, 3),
  fn(["global"], "link", "path | file, display?", "link", "Creates a link.", 1, 2),
  fn(["global"], "list", "element", "list", "Wraps a value in a list.", 1, 1),
  fn(["global"], "max", "...numbers", "number", "Largest number.", 1, null),
  fn(["global"], "now", "", "date", "Current time.", 0, 0),
  fn(["global"], "today", "", "date", "Today at midnight.", 0, 0),
  fn(["any"], "toString", "", "string", "As text.", 0, 0),
  fn(["any"], "isTruthy", "", "boolean", "Truthiness.", 0, 0),
  fn(
    ["null", "string", "number", "date", "list", "object"],
    "isEmpty",
    "",
    "boolean",
    "Empty?",
    0,
    0,
  ),
  fn(["string"], "contains", "value", "boolean", "String contains.", 1, 1),
  fn(["string"], "lower", "", "string", "Lower case.", 0, 0),
  fn(["string"], "slice", "start, end?", "string", "Part of a string.", 1, 2),
  fn(["string"], "split", "separator, n?", "list", "Splits a string.", 1, 2),
  fn(["string"], "trim", "", "string", "Trims.", 0, 0),
  fn(["number"], "round", "digits?", "number", "Rounds.", 0, 1),
  fn(["number"], "toFixed", "precision", "string", "Fixed decimals.", 1, 1),
  fn(["date"], "format", "format", "string", "Formats a date.", 1, 1),
  fn(["date"], "relative", "", "string", "Relative time.", 0, 0),
  fn(["list"], "contains", "value", "boolean", "List contains.", 1, 1),
  fn(["list"], "filter", "expression", "list", "Filters.", 1, 1),
  fn(["list"], "join", "separator", "string", "Joins.", 1, 1),
  fn(["list"], "map", "expression", "list", "Maps.", 1, 1),
  fn(["list"], "reduce", "expression, initial", "any", "Folds.", 2, 2),
  fn(["list"], "slice", "start, end?", "list", "Part of a list.", 1, 2),
  fn(["list"], "sum", "", "number", "Sum.", 0, 0),
  fn(["link"], "asFile", "", "file", "Link target.", 0, 0),
  fn(["file"], "hasTag", "...tags", "boolean", "Has a tag.", 1, null),
  fn(["file"], "inFolder", "folder", "boolean", "In a folder.", 1, 1),
  fn(["file"], "asLink", "display?", "link", "As link.", 0, 1),
  fn(["object"], "keys", "", "list", "Keys.", 0, 0),
];

export function completionEnv(partial: Partial<CompletionEnv> = {}): CompletionEnv {
  return {
    functions: FUNCTIONS,
    properties: [
      { key: "status", count: 10, types: { text: 10 } },
      { key: "due", count: 8, types: { date: 8 } },
      { key: "tags", count: 9, types: { list: 9 } },
      { key: "priority", count: 6, types: { number: 6 } },
      { key: "done", count: 6, types: { bool: 6 } },
      { key: "owner", count: 4, types: { link: 4 } },
      { key: "mixed", count: 4, types: { text: 2, number: 2 } },
      { key: "creation date", count: 3, types: { date: 3 } },
      { key: "file", count: 1, types: { text: 1 } },
    ],
    formulas: {
      age: "now().year",
      title: "file.name.lower().trim()",
      due_text: "due.format('YYYY')",
      loop_a: "formula.loop_b",
      loop_b: "formula.loop_a",
      "odd name": "priority",
    },
    ...partial,
  };
}
