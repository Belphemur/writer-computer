import { useCallback, useEffect, useRef, useState } from "react";
import { getWorkspaceRoot } from "@/hooks/workspace-api";
import {
  READ_ONLY_REASONS,
  cellCopyText,
  classifyValue,
  columnReadOnlyReason,
  editTargetFor,
  jsonEqual,
  parseCellText,
  rawToCell,
  toWireType,
  valueTypeOfRaw,
  type EditKind,
  type ParsedCellText,
} from "@/lib/bases/cells";
import { noteProperties, notePropertyRemove, notePropertySet } from "@/lib/bases/ipc";
import { toAbsolutePath } from "@/lib/bases/paths";
import type { BaseQueryResult, Cell, PropertyJson } from "@/lib/bases/types";
import { errorMessage } from "./use-base-query";
import { hasUnsavedEditorChanges, reloadOpenNoteAfterWrite } from "./open-note-sync";

/** One written property: enough to write the previous or the next value back. */
export interface EditOp {
  rowPath: string;
  name: string;
  /** Raw frontmatter value before / after; `undefined` means the key is absent. */
  before: unknown;
  after: unknown;
  beforeType: EditKind | undefined;
  afterType: EditKind | undefined;
}

export interface Notice {
  id: number;
  kind: "error" | "info";
  message: string;
}

export type BeginEdit = { ok: true; kind: EditKind; raw: unknown } | { ok: false; reason: string };

/** A block of cells: data-row indices (any order, collapsed rows already excluded) by an inclusive column span. */
export interface CellRange {
  rows: readonly number[];
  colStart: number;
  colEnd: number;
}

class EditRejected extends Error {}

/** The same write seen from the other side: what was written becomes what to restore. */
function invert(op: EditOp): EditOp {
  return {
    ...op,
    before: op.after,
    after: op.before,
    beforeType: op.afterType,
    afterType: op.beforeType,
  };
}

const overrideKey = (rowPath: string, name: string) => `${rowPath}\u0000${name}`;

interface Params {
  /** The table's current query result. */
  result: BaseQueryResult | null;
  refresh: () => Promise<void>;
}

/** Plan for one cell write before it is queued. */
interface Plan {
  rowPath: string;
  name: string;
  next: unknown;
  nextType: EditKind | undefined;
  beforeType: EditKind | undefined;
}

/**
 * The cell-edit pipeline of a base table (spec phase 3). Every write goes through one serialized
 * queue and one function (`runWrite`): check the note is writable, read the current raw value,
 * write or remove the property, reload a clean open editor, record an undo entry. The cell shows
 * the new value optimistically from the moment the edit is accepted; a failed write rolls the
 * cell back and raises an error notice. After the queue drains the table requeries, and an
 * optimistic cell is dropped once a query that started after its write has landed.
 */
export function useBaseEdits({ result, refresh }: Params) {
  const [overrides, setOverrides] = useState<ReadonlyMap<string, Cell>>(new Map());
  const [notice, setNotice] = useState<Notice | null>(null);
  // Frontmatter errors found for the current result's rows; a new result clears them.
  const [frontmatterErrors, setFrontmatterErrors] = useState<{
    result: BaseQueryResult | null;
    errors: ReadonlyMap<string, string>;
  }>({ result: null, errors: new Map() });

  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const tokens = useRef(new Map<string, number>());
  const tokenCounter = useRef(0);
  const noticeCounter = useRef(0);
  const undoStack = useRef<EditOp[][]>([]);
  const redoStack = useRef<EditOp[][]>([]);
  const probed = useRef<{ result: BaseQueryResult | null; rows: Set<string> }>({
    result: null,
    rows: new Set(),
  });
  const latestResult = useRef(result);
  useEffect(() => {
    latestResult.current = result;
  }, [result]);

  const notify = useCallback((kind: Notice["kind"], message: string) => {
    noticeCounter.current += 1;
    setNotice({ id: noticeCounter.current, kind, message });
  }, []);
  const dismissNotice = useCallback(() => setNotice(null), []);

  const absoluteOf = useCallback((rowPath: string): string => {
    const root = getWorkspaceRoot();
    if (!root) throw new EditRejected("No workspace is open");
    return toAbsolutePath(root, rowPath);
  }, []);

  const frontmatterErrorOf = useCallback(
    (rowPath: string): string | undefined =>
      frontmatterErrors.result === result ? frontmatterErrors.errors.get(rowPath) : undefined,
    [frontmatterErrors, result],
  );

  const rememberFrontmatterError = useCallback((rowPath: string, error: string) => {
    setFrontmatterErrors((s) => {
      const current = latestResult.current;
      const errors = new Map(s.result === current ? s.errors : []);
      if (errors.get(rowPath) === error && s.result === current) return s;
      errors.set(rowPath, error);
      return { result: current, errors };
    });
  }, []);

  // ---- read-only reasons -------------------------------------------------

  /** Why this cell cannot be edited right now, or `null`. */
  const readOnlyReason = useCallback(
    (rowIndex: number, colIndex: number): string | null => {
      if (!result) return "No data";
      const row = result.rows[rowIndex];
      const column = result.columns[colIndex];
      const cell = row?.cells[colIndex];
      if (!row || !column || !cell) return "No such cell";
      // Reasons only: no column-kind inference here, this runs for rendered cells.
      const columnReason = columnReadOnlyReason(column);
      if (columnReason) return columnReason;
      const classified = classifyValue(cell);
      if (!classified.editable) return classified.reason;
      const fm = frontmatterErrorOf(row.path);
      if (fm) return `${READ_ONLY_REASONS.frontmatter} (${fm})`;
      const root = getWorkspaceRoot();
      if (root && hasUnsavedEditorChanges(toAbsolutePath(root, row.path)))
        return READ_ONLY_REASONS.unsaved;
      return null;
    },
    [result, frontmatterErrorOf],
  );

  /** Look up the note's frontmatter once per result so a read-only reason can show before an edit. */
  const probeRow = useCallback(
    (rowIndex: number) => {
      const current = latestResult.current;
      const row = current?.rows[rowIndex];
      if (!current || !row) return;
      if (probed.current.result !== current) probed.current = { result: current, rows: new Set() };
      if (probed.current.rows.has(row.path)) return;
      probed.current.rows.add(row.path);
      let abs: string;
      try {
        abs = absoluteOf(row.path);
      } catch {
        return;
      }
      noteProperties(abs).then(
        (props) => {
          if (props.error) rememberFrontmatterError(row.path, props.error);
        },
        (e) => notify("error", `Could not read properties of ${row.path}: ${errorMessage(e)}`),
      );
    },
    [absoluteOf, notify, rememberFrontmatterError],
  );

  // ---- the one write path ------------------------------------------------

  const setOverride = useCallback((key: string, cell: Cell | null) => {
    setOverrides((m) => {
      const next = new Map(m);
      if (cell) next.set(key, cell);
      else next.delete(key);
      return next;
    });
  }, []);

  /** One property write. Throws `EditRejected` for a refused edit, anything else for a failure. */
  const runWrite = useCallback(
    async (
      plan: Plan,
      origin: "edit" | "undo" | "redo",
      expectCurrent: unknown,
    ): Promise<EditOp | null> => {
      const abs = absoluteOf(plan.rowPath);
      if (hasUnsavedEditorChanges(abs)) throw new EditRejected(READ_ONLY_REASONS.unsaved);
      const props = await noteProperties(abs);
      if (props.error) {
        rememberFrontmatterError(plan.rowPath, props.error);
        throw new EditRejected(`${READ_ONLY_REASONS.frontmatter} (${props.error})`);
      }
      const before: unknown = Object.prototype.hasOwnProperty.call(props.properties, plan.name)
        ? props.properties[plan.name]
        : undefined;
      if (origin !== "edit" && !jsonEqual(before, expectCurrent))
        throw new EditRejected(
          `"${plan.name}" in ${plan.rowPath} changed since the edit, so it was not ${origin === "undo" ? "undone" : "redone"}`,
        );
      if (jsonEqual(before, plan.next)) return null;
      if (plan.next === undefined) {
        await notePropertyRemove({ path: abs, name: plan.name });
      } else {
        const valueType = toWireType(plan.nextType ?? valueTypeOfRaw(plan.next));
        await notePropertySet({
          path: abs,
          name: plan.name,
          value: plan.next as PropertyJson,
          ...(valueType ? { valueType } : {}),
        });
      }
      try {
        await reloadOpenNoteAfterWrite(abs);
      } catch (e) {
        notify("error", errorMessage(e));
      }
      return {
        rowPath: plan.rowPath,
        name: plan.name,
        before,
        after: plan.next,
        beforeType: plan.beforeType ?? valueTypeOfRaw(before),
        afterType: plan.nextType,
      };
    },
    [absoluteOf, notify, rememberFrontmatterError],
  );

  /**
   * Queue a group of writes (one undo step). Cells update optimistically at once; each write that
   * fails rolls its cell back and reports; the successful writes form the undo step.
   */
  const submit = useCallback(
    (
      plans: Plan[],
      origin: "edit" | "undo" | "redo",
      expectations: unknown[] = [],
    ): Promise<EditOp[]> => {
      const issued = plans.map((plan) => {
        const key = overrideKey(plan.rowPath, plan.name);
        tokenCounter.current += 1;
        const token = tokenCounter.current;
        tokens.current.set(key, token);
        setOverride(key, rawToCell(plan.next, plan.nextType));
        return { plan, key, token };
      });
      const clearIfOurs = (key: string, token: number) => {
        if (tokens.current.get(key) !== token) return;
        tokens.current.delete(key);
        setOverride(key, null);
      };

      const job = async (): Promise<EditOp[]> => {
        const done: EditOp[] = [];
        for (let i = 0; i < issued.length; i++) {
          const { plan, key, token } = issued[i]!;
          try {
            const op = await runWrite(plan, origin, expectations[i]);
            if (op) done.push(op);
            else clearIfOurs(key, token);
          } catch (e) {
            clearIfOurs(key, token);
            notify(
              "error",
              e instanceof EditRejected
                ? e.message
                : `Could not save "${plan.name}" in ${plan.rowPath}: ${errorMessage(e)}`,
            );
          }
        }
        if (done.length > 0) {
          if (origin === "edit") {
            undoStack.current.push(done);
            redoStack.current = [];
          } else if (origin === "undo") {
            // Stored the way the original edit was made, in its original order.
            redoStack.current.push(done.map(invert).reverse());
          } else {
            undoStack.current.push(done);
          }
          // Drop the optimistic cells once a query that started after the writes has landed.
          // Not awaited: the queue keeps moving, and a newer write to a cell owns its token.
          void refresh().then(() => {
            for (const { key, token } of issued) clearIfOurs(key, token);
          });
        }
        return done;
      };
      const run = queue.current.then(job, job);
      queue.current = run.catch(() => undefined);
      return run;
    },
    [notify, refresh, runWrite, setOverride],
  );

  // ---- editing entry points ----------------------------------------------

  const planFor = useCallback(
    (
      rowIndex: number,
      colIndex: number,
      next: unknown,
      nextType: EditKind | undefined,
    ): Plan | { error: string } => {
      const reason = readOnlyReason(rowIndex, colIndex);
      if (reason) return { error: reason };
      const row = result!.rows[rowIndex]!;
      const column = result!.columns[colIndex]!;
      const target = editTargetFor(column, row.cells[colIndex]!, result!.rows, colIndex);
      const beforeType =
        target.editable && row.cells[colIndex]!.type !== "null" ? target.kind : undefined;
      return { rowPath: row.path, name: column.key, next, nextType, beforeType };
    },
    [readOnlyReason, result],
  );

  /** Open an editor on a cell: refuses read-only cells, reads the raw value for the editor. */
  const beginEdit = useCallback(
    async (rowIndex: number, colIndex: number): Promise<BeginEdit> => {
      const reason = readOnlyReason(rowIndex, colIndex);
      if (reason) return { ok: false, reason };
      const current = latestResult.current!;
      const row = current.rows[rowIndex]!;
      const column = current.columns[colIndex]!;
      const target = editTargetFor(column, row.cells[colIndex]!, current.rows, colIndex);
      if (!target.editable) return { ok: false, reason: target.reason };
      try {
        const props = await noteProperties(absoluteOf(row.path));
        if (props.error) {
          rememberFrontmatterError(row.path, props.error);
          return {
            ok: false,
            reason: `${READ_ONLY_REASONS.frontmatter} (${props.error})`,
          };
        }
        const raw = Object.prototype.hasOwnProperty.call(props.properties, column.key)
          ? props.properties[column.key]
          : undefined;
        return { ok: true, kind: target.kind, raw };
      } catch (e) {
        return { ok: false, reason: `Could not read ${row.path}: ${errorMessage(e)}` };
      }
    },
    [absoluteOf, readOnlyReason, rememberFrontmatterError],
  );

  const applyParsed = useCallback(
    (rowIndex: number, colIndex: number, parsed: ParsedCellText & { ok: true }) => {
      const plan = planFor(
        rowIndex,
        colIndex,
        parsed.clear ? undefined : parsed.value,
        parsed.clear ? undefined : parsed.valueType,
      );
      if ("error" in plan) {
        notify("error", plan.error);
        return Promise.resolve([] as EditOp[]);
      }
      return submit([plan], "edit");
    },
    [notify, planFor, submit],
  );

  /** Commit text typed into an editor. Returns `false` (editor stays open) for invalid text. */
  const commitText = useCallback(
    (rowIndex: number, colIndex: number, kind: EditKind, text: string): boolean => {
      const parsed = parseCellText(kind, text);
      if (!parsed.ok) {
        notify("error", parsed.error);
        return false;
      }
      void applyParsed(rowIndex, colIndex, parsed);
      return true;
    },
    [applyParsed, notify],
  );

  /** Commit the items of the list editor. */
  const commitList = useCallback(
    (rowIndex: number, colIndex: number, items: string[]): boolean => {
      const cleaned = items.map((s) => s.trim()).filter((s) => s !== "");
      const parsed: ParsedCellText & { ok: true } =
        cleaned.length === 0
          ? { ok: true, clear: true }
          : { ok: true, clear: false, value: cleaned, valueType: "list" };
      void applyParsed(rowIndex, colIndex, parsed);
      return true;
    },
    [applyParsed],
  );

  const toggleCheckbox = useCallback(
    (rowIndex: number, colIndex: number) => {
      const cell = result?.rows[rowIndex]?.cells[colIndex];
      if (!cell) return;
      const current =
        overrides.get(overrideKey(result!.rows[rowIndex]!.path, result!.columns[colIndex]!.key)) ??
        cell;
      const next = current.type === "boolean" ? !current.value : true;
      void applyParsed(rowIndex, colIndex, {
        ok: true,
        clear: false,
        value: next,
        valueType: "checkbox",
      });
    },
    [applyParsed, overrides, result],
  );

  /** Clear (remove the property of) every cell of the range. One undo step. */
  const clearRange = useCallback(
    (range: CellRange) => {
      if (!result) return;
      const plans: Plan[] = [];
      for (const r of range.rows) {
        for (let c = range.colStart; c <= range.colEnd; c++) {
          const plan = planFor(r, c, undefined, undefined);
          if ("error" in plan) {
            notify("error", `Nothing cleared: ${plan.error}`);
            return;
          }
          plans.push(plan);
        }
      }
      void submit(plans, "edit");
    },
    [notify, planFor, result, submit],
  );

  /** Text of a range, tab between columns and newline between rows, as the user sees it. */
  const copyText = useCallback(
    (range: CellRange): string => {
      if (!result) return "";
      const lines: string[] = [];
      for (const r of range.rows) {
        const row = result.rows[r];
        if (!row) continue;
        const parts: string[] = [];
        for (let c = range.colStart; c <= range.colEnd; c++) {
          const cell = overrides.get(overrideKey(row.path, result.columns[c]!.key)) ?? row.cells[c];
          parts.push(cell ? cellCopyText(cell).replace(/[\t\r\n]+/g, " ") : "");
        }
        lines.push(parts.join("\t"));
      }
      return lines.join("\n");
    },
    [overrides, result],
  );

  /**
   * Paste tab/newline separated text with its top-left cell at (row, col), where `rowOrder` maps
   * block rows to data-row indices (so collapsed groups are skipped). All cells are validated
   * first; nothing is written when any cell is invalid, read-only or outside the table.
   */
  const pasteText = useCallback(
    (text: string, rowOrder: readonly number[], startPos: number, colIndex: number) => {
      if (!result) return;
      const lines = text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");
      const plans: Plan[] = [];
      for (let i = 0; i < lines.length; i++) {
        const rowIndex = rowOrder[startPos + i];
        const cells = lines[i]!.split("\t");
        for (let j = 0; j < cells.length; j++) {
          const c = colIndex + j;
          if (rowIndex === undefined || c >= result.columns.length) {
            notify(
              "error",
              "Nothing pasted: the clipboard is larger than the table below and to the right of the selected cell",
            );
            return;
          }
          const column = result.columns[c]!;
          const row = result.rows[rowIndex]!;
          const target = editTargetFor(column, row.cells[c]!, result.rows, c);
          if (!target.editable) {
            notify("error", `Nothing pasted: ${target.reason} (${column.displayName})`);
            return;
          }
          const parsed = parseCellText(target.kind, cells[j]!);
          if (!parsed.ok) {
            notify("error", `Nothing pasted: ${parsed.error} (${column.displayName}, ${row.path})`);
            return;
          }
          const plan = planFor(
            rowIndex,
            c,
            parsed.clear ? undefined : parsed.value,
            parsed.clear ? undefined : parsed.valueType,
          );
          if ("error" in plan) {
            notify("error", `Nothing pasted: ${plan.error}`);
            return;
          }
          plans.push(plan);
        }
      }
      void submit(plans, "edit");
    },
    [notify, planFor, result, submit],
  );

  // ---- undo / redo -------------------------------------------------------

  const stepHistory = useCallback(
    (direction: "undo" | "redo") => {
      const from = direction === "undo" ? undoStack : redoStack;
      const group = from.current.pop();
      if (!group) {
        notify("info", direction === "undo" ? "Nothing to undo" : "Nothing to redo");
        return;
      }
      // Undo walks the group backwards, redo forwards.
      const ops = direction === "undo" ? [...group].reverse() : group;
      const plans: Plan[] = ops.map((op) => ({
        rowPath: op.rowPath,
        name: op.name,
        next: direction === "undo" ? op.before : op.after,
        nextType:
          direction === "undo"
            ? (op.beforeType ?? valueTypeOfRaw(op.before))
            : (op.afterType ?? valueTypeOfRaw(op.after)),
        beforeType: direction === "undo" ? op.afterType : op.beforeType,
      }));
      const expectations = ops.map((op) => (direction === "undo" ? op.after : op.before));
      // A step that cannot be applied is dropped (with a notice), not retried on the next press;
      // a step that is applied leaves its inverse on the opposite stack (see `submit`).
      void submit(plans, direction, expectations);
    },
    [notify, submit],
  );

  const undo = useCallback(() => stepHistory("undo"), [stepHistory]);
  const redo = useCallback(() => stepHistory("redo"), [stepHistory]);

  /** The cell as displayed: the optimistic value while a write is pending, else the query's. */
  const cellAt = useCallback(
    (rowIndex: number, colIndex: number): Cell | undefined => {
      const row = result?.rows[rowIndex];
      const column = result?.columns[colIndex];
      if (!row || !column) return undefined;
      return overrides.get(overrideKey(row.path, column.key)) ?? row.cells[colIndex];
    },
    [overrides, result],
  );

  return {
    notice,
    dismissNotice,
    notify,
    cellAt,
    readOnlyReason,
    probeRow,
    beginEdit,
    commitText,
    commitList,
    toggleCheckbox,
    clearRange,
    copyText,
    pasteText,
    undo,
    redo,
  };
}
