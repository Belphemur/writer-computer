import { useRef, useState } from "react";
import { MODAL_PANEL, ModalShell } from "@/components/modal-shell";
import { showEditorNotice } from "@/components/editor-area/editor-notice-store";
import { taskAdd, type TaskFieldInput } from "../ipc";
import { useTasksUi } from "../store";
import { DialogButtons, FIELD, Labeled, PrioritySelect } from "./fields";

/** The fields a quick add can set, as the command takes them (empty ones are left out). */
export function quickAddFields(v: {
  due: string;
  scheduled: string;
  priority: string;
  recurrence: string;
}): TaskFieldInput[] {
  return (Object.entries(v) as [string, string][])
    .filter(([, value]) => value.trim() !== "")
    .map(([field, value]) => ({ field, value: value.trim() }));
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : typeof e === "string" ? e : "Could not add the task.";
}

/** The quick-add dialog: one task appended to the inbox note (`tasks.inbox`). */
export function QuickAdd() {
  const open = useTasksUi((s) => s.quickAdd);
  const close = useTasksUi((s) => s.closeQuickAdd);
  return open ? <Body onClose={close} /> : null;
}

function Body({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState("");
  const [due, setDue] = useState("");
  const [scheduled, setScheduled] = useState("");
  const [priority, setPriority] = useState("");
  const [recurrence, setRecurrence] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement>(null);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const change = await taskAdd(text, quickAddFields({ due, scheduled, priority, recurrence }));
      showEditorNotice(`Added to ${change.path}`);
      onClose();
    } catch (e) {
      setError(describe(e));
      setBusy(false);
    }
  };

  return (
    <ModalShell
      labelledBy="tasks-quick-add-title"
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
        <h2
          id="tasks-quick-add-title"
          className="text-[15px] font-semibold text-[var(--text-primary)]"
        >
          Add task
        </h2>
        <input
          ref={first}
          className={FIELD}
          value={text}
          placeholder="Task"
          aria-label="Task"
          onChange={(e) => setText(e.target.value)}
        />
        <div className="grid grid-cols-2 gap-3">
          <Labeled label="Due">
            <input
              type="date"
              className={FIELD}
              value={due}
              onChange={(e) => setDue(e.target.value)}
            />
          </Labeled>
          <Labeled label="Scheduled">
            <input
              type="date"
              className={FIELD}
              value={scheduled}
              onChange={(e) => setScheduled(e.target.value)}
            />
          </Labeled>
          <Labeled label="Priority">
            <PrioritySelect value={priority} onChange={setPriority} />
          </Labeled>
          <Labeled label="Repeats">
            <input
              className={FIELD}
              value={recurrence}
              placeholder="every week"
              onChange={(e) => setRecurrence(e.target.value)}
            />
          </Labeled>
        </div>
        {error ? (
          <p role="alert" className="text-[12px] text-[var(--text-danger,#d33)]">
            {error}
          </p>
        ) : null}
        <DialogButtons onCancel={onClose} submitLabel="Add" busy={busy || text.trim() === ""} />
      </form>
    </ModalShell>
  );
}
