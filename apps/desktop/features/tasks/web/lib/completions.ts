// What the editor offers after a task signifier or a Dataview-format key (`due::`): dates
// (today, tomorrow, weekdays, next week and month), priorities and recurrence phrases. Pure: a line
// before the caret and a day in, options out, so the sources are testable without an editor.
// The values written are what Rust reads (`YYYY-MM-DD`, the five priority names, a recurrence
// phrase `tasks/recurrence.rs` parses).

export interface TaskOption {
  label: string;
  /** The text written in place of what was typed. */
  apply: string;
  detail?: string;
}

export interface TaskCompletion {
  /** Offset in the line where the typed part of the value starts. */
  from: number;
  options: TaskOption[];
}

const DATE_SIGNIFIERS = ["📅", "📆", "🗓️", "🗓", "⏳", "⌛", "🛫", "➕", "✅", "❌"];
const DATE_KEYS = ["due", "scheduled", "start", "created", "completion", "cancelled"];
const PRIORITIES = ["highest", "high", "medium", "low", "lowest"];
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
export const RECURRENCES = [
  "every day",
  "every weekday",
  "every week",
  "every 2 weeks",
  "every month",
  "every year",
  "every day when done",
  "every week when done",
  "every month when done",
];

/** A line that is a task: list marker, a checkbox with any one character, a space. */
const TASK_LINE = /^[ \t]*(?:[-+*]|\d+[.)])[ \t]+\[.\][ \t]/;

export const isoDay = (d: Date): string =>
  `${String(d.getFullYear()).padStart(4, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function addDays(d: Date, n: number): Date {
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  return out;
}

function addMonth(d: Date): Date {
  const out = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  const last = new Date(out.getFullYear(), out.getMonth() + 1, 0).getDate();
  out.setDate(Math.min(d.getDate(), last));
  return out;
}

/** The days a date value can name, with the word that names it. */
export function dateOptions(today: Date): TaskOption[] {
  const options: TaskOption[] = [
    { label: "today", apply: isoDay(today) },
    { label: "tomorrow", apply: isoDay(addDays(today, 1)) },
    { label: "next week", apply: isoDay(addDays(today, 7)) },
    { label: "next month", apply: isoDay(addMonth(today)) },
  ];
  // the next occurrence of each weekday, strictly after today
  for (let n = 1; n <= 7; n++) {
    const d = addDays(today, n);
    options.push({ label: WEEKDAYS[d.getDay()]!, apply: isoDay(d) });
  }
  return options.map((o) => ({ ...o, detail: o.apply }));
}

type Kind = "date" | "priority" | "recurrence";

/** The value being typed after the last signifier before the caret, if there is one. */
function valueContext(before: string): { kind: Kind; from: number } | null {
  // Dataview format: `[due:: ` or `(due:: ` with the value typed so far
  const dv = /[[(]([A-Za-z]+)::[ \t]*([^\])]*)$/.exec(before);
  if (dv) {
    const key = dv[1]!.toLowerCase();
    const kind: Kind | null = DATE_KEYS.includes(key)
      ? "date"
      : key === "priority"
        ? "priority"
        : key === "repeat"
          ? "recurrence"
          : null;
    return kind ? { kind, from: before.length - dv[2]!.length } : null;
  }
  // emoji format: the last signifier on the line, a space, the value typed so far
  let best: { kind: Kind; at: number; len: number } | null = null;
  for (const e of DATE_SIGNIFIERS) {
    const at = before.lastIndexOf(e);
    if (at >= 0 && (!best || at > best.at)) best = { kind: "date", at, len: e.length };
  }
  const rep = before.lastIndexOf("🔁");
  if (rep >= 0 && (!best || rep > best.at)) best = { kind: "recurrence", at: rep, len: 2 };
  if (!best) return null;
  const after = before.slice(best.at + best.len);
  // a value is one word for a date, a few for a recurrence; anything with another signifier or
  // too many words is not a value being typed
  if (!/^[ \t]?[^\s]*$/.test(after) && best.kind === "date") return null;
  if (best.kind === "recurrence" && !/^[ \t]?[A-Za-z0-9 !,]*$/.test(after)) return null;
  const lead = /^[ \t]?/.exec(after)![0].length;
  return { kind: best.kind, from: best.at + best.len + lead };
}

/** Options for the caret at the end of `before` (the line up to the caret), or null when the
 *  line is not a task or the caret is not in a value. */
export function taskCompletionAt(before: string, today: Date): TaskCompletion | null {
  if (!TASK_LINE.test(before)) return null;
  const ctx = valueContext(before);
  if (!ctx) return null;
  const options =
    ctx.kind === "date"
      ? dateOptions(today)
      : ctx.kind === "priority"
        ? PRIORITIES.map((p) => ({ label: p, apply: p }))
        : RECURRENCES.map((r) => ({ label: r, apply: r }));
  return { from: ctx.from, options };
}
