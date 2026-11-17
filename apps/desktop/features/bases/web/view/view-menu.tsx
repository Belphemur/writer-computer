import { useState, useSyncExternalStore } from "react";
import * as editorApi from "@/hooks/editor-api";
import {
  addView,
  deleteView,
  duplicateView,
  moveView,
  renameView,
  uniqueViewName,
} from "../lib/base-yaml";
import { listBaseViews, subscribeBaseViews } from "../lib/view-registry";
import type { MenuContext } from "./menu-context";
import { FIELD, SMALL_BUTTON, ToolbarMenu } from "./toolbar-menu";

function ViewBody({ ctx, close }: { ctx: MenuContext; close: () => void }) {
  const entries = useSyncExternalStore(subscribeBaseViews, listBaseViews, listBaseViews);
  const names = ctx.document.views.map((v) => v.name);
  const count = names.length;
  const [name, setName] = useState(ctx.view.name);
  const [confirming, setConfirming] = useState(false);

  /** Run the edit; on success select `select` (a view name) or the first view for `null`. */
  const run = async (
    edit: Parameters<MenuContext["apply"]>[0],
    select: string | null | undefined,
  ) => {
    const ok = await ctx.apply(edit);
    if (ok && select !== undefined) editorApi.setBaseTabView(ctx.tabId, select ?? undefined);
    if (ok) close();
  };

  return (
    <div className="flex flex-col gap-3">
      <label className="flex items-center gap-2">
        <span className="text-text-secondary">Name</span>
        <input
          aria-label="View name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && name !== ctx.view.name)
              void run((t) => renameView(t, ctx.viewIndex, name), name);
          }}
          className={`${FIELD} flex-1`}
        />
        <button
          type="button"
          disabled={name === ctx.view.name}
          onClick={() => void run((t) => renameView(t, ctx.viewIndex, name), name)}
          className={SMALL_BUTTON}
        >
          Rename
        </button>
      </label>
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          className={SMALL_BUTTON}
          onClick={() => {
            const copy = uniqueViewName(names, `${ctx.view.name} copy`);
            void run((t) => duplicateView(t, ctx.viewIndex, copy), copy);
          }}
        >
          Duplicate
        </button>
        <button
          type="button"
          disabled={ctx.viewIndex === 0}
          className={SMALL_BUTTON}
          onClick={() => void run((t) => moveView(t, ctx.viewIndex, ctx.viewIndex - 1), undefined)}
        >
          Move left
        </button>
        <button
          type="button"
          disabled={ctx.viewIndex === count - 1}
          className={SMALL_BUTTON}
          onClick={() => void run((t) => moveView(t, ctx.viewIndex, ctx.viewIndex + 1), undefined)}
        >
          Move right
        </button>
        {confirming ? (
          <button
            type="button"
            className={`${SMALL_BUTTON} text-[var(--danger)]`}
            onClick={() => void run((t) => deleteView(t, ctx.viewIndex), null)}
          >
            Confirm delete
          </button>
        ) : (
          <button
            type="button"
            disabled={count <= 1}
            title={count <= 1 ? "A base needs at least one view" : undefined}
            className={SMALL_BUTTON}
            onClick={() => setConfirming(true)}
          >
            Delete
          </button>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="text-[12px] text-text-secondary">Add view</div>
        <div className="flex flex-wrap gap-1.5">
          {entries.map((entry) => (
            <button
              key={entry.type}
              type="button"
              title={`Add a ${entry.name} view`}
              className={SMALL_BUTTON}
              onClick={() => {
                const fresh = uniqueViewName(names, entry.name);
                void run((t) => addView(t, { type: entry.type, name: fresh }), fresh);
              }}
            >
              {entry.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** View menu: rename, duplicate, reorder, delete the selected view; add a view of any registered type. */
export function ViewMenu({ ctx }: { ctx: MenuContext }) {
  return (
    <ToolbarMenu label="View" align="left">
      {(close) => <ViewBody key={ctx.view.name} ctx={ctx} close={close} />}
    </ToolbarMenu>
  );
}
