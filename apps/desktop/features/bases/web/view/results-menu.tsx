import { useState } from "react";
import { setLimit } from "../lib/base-yaml";
import { getWorkspaceRoot } from "@/hooks/workspace-api";
import { getFileName } from "@/lib/paths";
import type { MenuContext } from "./menu-context";
import { copyResultsAsMarkdown, exportResultsAsCsv } from "./results-actions";
import { FIELD, SMALL_BUTTON, ToolbarMenu } from "./toolbar-menu";
import { errorMessage } from "./use-base-query";

function LimitField({ ctx }: { ctx: MenuContext }) {
  const current = ctx.view.limit === null ? "" : String(ctx.view.limit);
  const [draft, setDraft] = useState(current);
  const commit = () => {
    if (draft.trim() === current) return;
    const text = draft.trim();
    if (text === "") return void ctx.apply((t) => setLimit(t, ctx.viewIndex, null));
    const n = Number(text);
    if (!Number.isInteger(n) || n < 1) {
      ctx.notify("error", "The limit must be a whole number of at least 1");
      setDraft(current);
      return;
    }
    void ctx.apply((t) => setLimit(t, ctx.viewIndex, n));
  };
  return (
    <label className="flex items-center gap-2">
      <span className="text-text-secondary">Limit</span>
      <input
        aria-label="Result limit"
        inputMode="numeric"
        placeholder="No limit"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && commit()}
        className={`${FIELD} w-24`}
      />
    </label>
  );
}

function ResultsBody({ ctx, close }: { ctx: MenuContext; close: () => void }) {
  const { result, shown } = ctx;
  const copy = async () => {
    if (!result) return;
    try {
      const n = await copyResultsAsMarkdown(result, shown);
      ctx.notify("info", `Copied ${n} ${n === 1 ? "row" : "rows"} as a markdown table`);
    } catch (e) {
      ctx.notify("error", `Could not copy the results: ${errorMessage(e)}`);
    }
    close();
  };
  const exportCsv = async () => {
    if (!result) return;
    close();
    try {
      const name = getFileName(ctx.path).replace(/\.base$/i, "");
      const saved = await exportResultsAsCsv(result, shown, `${name}.csv`, getWorkspaceRoot());
      if (saved) ctx.notify("info", `Exported ${result.rows.length} rows to ${saved}`);
    } catch (e) {
      ctx.notify("error", `Could not export the results: ${errorMessage(e)}`);
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <LimitField ctx={ctx} />
      <button type="button" disabled={!result} onClick={copy} className={SMALL_BUTTON}>
        Copy results to clipboard
      </button>
      <button type="button" disabled={!result} onClick={exportCsv} className={SMALL_BUTTON}>
        Export CSV…
      </button>
    </div>
  );
}

/** Results menu: row limit, copy as markdown table, export CSV. */
export function ResultsMenu({ ctx }: { ctx: MenuContext }) {
  return (
    <ToolbarMenu label="Results" badge={ctx.view.limit}>
      {(close) => <ResultsBody ctx={ctx} close={close} />}
    </ToolbarMenu>
  );
}
