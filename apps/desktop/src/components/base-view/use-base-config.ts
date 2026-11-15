import { useCallback, useMemo, useRef } from "react";
import { BaseYamlError, setColumnSize, setSort, setViewValue } from "@/lib/bases/base-yaml";
import { baseRead, baseWriteText } from "@/lib/bases/ipc";
import { cycleSort } from "@/lib/bases/sort";
import type { BaseView } from "@/lib/bases/types";
import type { ViewConfig } from "@/lib/bases/view-registry";
import { hasUnsavedEditorChanges, reloadOpenNoteAfterWrite } from "./open-note-sync";
import { errorMessage } from "./use-base-query";

interface Params {
  /** Absolute path of the `.base`. */
  path: string;
  /** Reload the document and requery; resolves when the new result has landed. */
  reload: () => Promise<void>;
  notify: (kind: "error", message: string) => void;
}

/** A change of the `.base` text: current text in, new text out (see `lib/bases/base-yaml.ts`). */
export type ConfigEdit = (text: string) => string;

export interface BaseConfigApi {
  /** Run one edit through the write path. Resolves `true` when the file changed on disk. */
  apply: (edit: ConfigEdit) => Promise<boolean>;
  /** The edits a view may request (`BaseViewProps.config`) for the view at `viewIndex`. */
  viewConfig: (viewIndex: number | null, view: BaseView | undefined) => ViewConfig;
}

/**
 * The single write path for `.base` edits. Edits are serialized (a second one waits for the
 * first), each starts from the file's current text on disk, is refused while the file is open in
 * a text tab with unsaved changes, is skipped when it changes nothing, and is followed by a
 * reload of the document and the query. Failures raise an error notice; nothing is retried.
 */
export function useBaseConfig({ path, reload, notify }: Params): BaseConfigApi {
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const latest = useRef({ path, reload, notify });
  latest.current = { path, reload, notify };

  const run = useCallback(async (edit: ConfigEdit): Promise<boolean> => {
    const { path: file, reload: refresh, notify: raise } = latest.current;
    try {
      if (hasUnsavedEditorChanges(file))
        throw new Error(
          "The .base file is open in a text tab with unsaved changes. Save or close that tab first.",
        );
      const read = await baseRead(file);
      const next = edit(read.text);
      if (next === read.text) return false;
      await baseWriteText(file, next);
      try {
        await reloadOpenNoteAfterWrite(file);
      } catch (e) {
        raise(
          "error",
          errorMessage(e).replace("The note", "The .base file").replace("cell", "setting"),
        );
      }
      await refresh();
      return true;
    } catch (e) {
      raise(
        "error",
        e instanceof BaseYamlError ? e.message : `Could not update ${file}: ${errorMessage(e)}`,
      );
      return false;
    }
  }, []);

  const apply = useCallback(
    (edit: ConfigEdit): Promise<boolean> => {
      const next = queue.current.then(() => run(edit));
      queue.current = next.catch(() => undefined);
      return next;
    },
    [run],
  );

  const viewConfig = useCallback(
    (viewIndex: number | null, view: BaseView | undefined): ViewConfig => {
      const requireIndex = (): number => {
        if (viewIndex === null)
          throw new BaseYamlError("This base has no views yet: add a view first");
        return viewIndex;
      };
      return {
        cycleSort: (columnId, append) =>
          void apply((text) =>
            setSort(text, requireIndex(), cycleSort(view?.sort ?? [], columnId, append)),
          ),
        setColumnWidth: (columnId, px) =>
          void apply((text) => setColumnSize(text, requireIndex(), columnId, px)),
        setOption: (key, value) =>
          void apply((text) => setViewValue(text, requireIndex(), key, value)),
      };
    },
    [apply],
  );

  return useMemo(() => ({ apply, viewConfig }), [apply, viewConfig]);
}
