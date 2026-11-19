import { useEffect, useRef, useState } from "react";
import { MODAL_PANEL, ModalShell } from "@/components/modal-shell";
import { showEditorNotice } from "@/components/editor-area/editor-notice-store";
import { replaceLineSpec } from "../lib/editor-lines";
import { taskLineInfo, taskLineSet, type TaskLineInfo } from "../ipc";
import { useTasksUi, type EditTarget } from "../store";
import { DialogButtons, FIELD, Labeled, PrioritySelect } from "./fields";

const FIELDS = ["due", "scheduled", "start", "priority", "recurrence"] as const;
type FieldName = (typeof FIELDS)[number];
type Values = Record<FieldName, string>;

export const valuesOf = (info: TaskLineInfo): Values => ({
  due: info.due ?? "",
  scheduled: info.scheduled ?? "",
  start: info.start ?? "",
  priority: info.priority ?? "",
  recurrence: info.recurrence ?? "",
});

/** The line after setting (or clearing) each field whose value differs from `before`, in order.
 *  `set` is the Rust edit of one field of one line, so the format and the token order stay its. */
export async function applyFieldEdits(
  line: string,
  before: Values,
  after: Values,
  set: (line: string, edit: { field: string; value: string | null }) => Promise<string>,
): Promise<string> {
  let current = line;
  for (const field of FIELDS) {
    const next = after[field].trim();
    if (next === before[field]) continue;
    current = await set(current, { field, value: next === "" ? null : next });
  }
  return current;
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : typeof e === "string" ? e : "Could not change the task.";
}

/** The edit dialog of the task line under the caret: dates, priority and recurrence. */
export function EditDialog() {
  const target = useTasksUi((s) => s.edit);
  const close = useTasksUi((s) => s.closeEdit);
  return target ? (
    <Body key={`${target.from}:${target.text}`} target={target} onClose={close} />
  ) : null;
}

function Body({ target, onClose }: { target: EditTarget; onClose: () => void }) {
  const [info, setInfo] = useState<TaskLineInfo | null>(null);
  const [values, setValues] = useState<Values | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let current = true;
    taskLineInfo(target.text).then(
      (i) => {
        if (!current) return;
        if (!i) return onClose();
        setInfo(i);
        setValues(valuesOf(i));
      },
      (e) => current && setError(describe(e)),
    );
    return () => {
      current = false;
    };
  }, [target.text, onClose]);

  const submit = async () => {
    if (!info || !values || busy) return;
    setBusy(true);
    try {
      const line = await applyFieldEdits(target.text, valuesOf(info), values, taskLineSet);
      const spec = replaceLineSpec(target.view.state, target.from, target.text, [line]);
      if (!spec) {
        showEditorNotice("The task changed meanwhile; try again.");
      } else {
        target.view.dispatch(spec);
      }
      onClose();
    } catch (e) {
      setError(describe(e));
      setBusy(false);
    }
  };

  const set = (field: FieldName) => (v: string) =>
    setValues((cur) => (cur ? { ...cur, [field]: v } : cur));

  return (
    <ModalShell
      labelledBy="tasks-edit-title"
      onClose={onClose}
      initialFocus={first}
      className={`flex w-full max-w-[420px] flex-col ${MODAL_PANEL}`}
    >
      <form
        className="flex flex-col gap-3 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h2 id="tasks-edit-title" className="text-[15px] font-semibold text-[var(--text-primary)]">
          Edit task
        </h2>
        {info ? (
          <p className="truncate text-[12px] text-[var(--text-muted)]" title={info.description}>
            {info.description}
          </p>
        ) : null}
        {values ? (
          <div className="grid grid-cols-2 gap-3">
            <Labeled label="Due">
              <input
                ref={first}
                type="date"
                className={FIELD}
                value={values.due}
                onChange={(e) => set("due")(e.target.value)}
              />
            </Labeled>
            <Labeled label="Scheduled">
              <input
                type="date"
                className={FIELD}
                value={values.scheduled}
                onChange={(e) => set("scheduled")(e.target.value)}
              />
            </Labeled>
            <Labeled label="Start">
              <input
                type="date"
                className={FIELD}
                value={values.start}
                onChange={(e) => set("start")(e.target.value)}
              />
            </Labeled>
            <Labeled label="Priority">
              <PrioritySelect value={values.priority} onChange={set("priority")} />
            </Labeled>
            <Labeled label="Repeats">
              <input
                className={FIELD}
                value={values.recurrence}
                placeholder="every week"
                onChange={(e) => set("recurrence")(e.target.value)}
              />
            </Labeled>
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-[12px] text-[var(--text-danger,#d33)]">
            {error}
          </p>
        ) : null}
        <DialogButtons onCancel={onClose} submitLabel="Save" busy={busy || !values} />
      </form>
    </ModalShell>
  );
}
