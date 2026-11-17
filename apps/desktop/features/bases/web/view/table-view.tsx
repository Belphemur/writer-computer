import type { BaseViewProps } from "../lib/view-registry";
import { BaseTable } from "./base-table";
import { useBaseEditsContext } from "./edits-context";

/** The registered `table` view: the editable grid. */
export function TableView({ result, view, actions, config, label }: BaseViewProps) {
  const edits = useBaseEditsContext();
  return (
    <BaseTable
      result={result}
      view={view}
      edits={edits}
      actions={actions}
      config={config}
      label={label}
    />
  );
}
