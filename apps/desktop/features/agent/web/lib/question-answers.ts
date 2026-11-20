/**
 * The answers a question card collects, as pure functions (the card renders them): which options
 * are picked, the "Other" text, when a question counts as answered, and the answers handed to the
 * backend. One question may be a single choice (radio) or a multi-select (checkboxes); "Other" is
 * one more choice that carries free text.
 */
import type { Question, QuestionAnswer } from "./events";

export type QuestionDraft = {
  /** Indexes of the picked options, ascending. */
  picked: number[];
  other: string;
  /** "Other" is a chosen answer (its text still has to be non-empty to count). */
  otherOn: boolean;
};

export const emptyDraft = (): QuestionDraft => ({ picked: [], other: "", otherOn: false });

/** Clicks, 1-9 and Space on option `i`: a single choice replaces everything, a multi-select toggles. */
export function toggleOption(q: Question, d: QuestionDraft, i: number): QuestionDraft {
  if (!q.multiSelect) return { ...d, picked: [i], otherOn: false };
  const picked = d.picked.includes(i)
    ? d.picked.filter((p) => p !== i)
    : [...d.picked, i].sort((a, b) => a - b);
  return { ...d, picked };
}

/** Picks or drops the "Other" choice itself. */
export function toggleOther(q: Question, d: QuestionDraft): QuestionDraft {
  if (!q.multiSelect) return { ...d, picked: [], otherOn: true };
  return { ...d, otherOn: !d.otherOn };
}

/** Typing in the "Other" field chooses it (and, in a single choice, drops the options); clearing
 *  the text in a multi-select drops it again. */
export function setOther(q: Question, d: QuestionDraft, other: string): QuestionDraft {
  if (!q.multiSelect) return { picked: [], other, otherOn: true };
  return { ...d, other, otherOn: other.trim() !== "" };
}

/** The labels of the picked options, then the typed text: one entry each. */
export function answerOf(q: Question, d: QuestionDraft): string[] {
  const labels = d.picked.map((i) => q.options[i]?.label).filter((l): l is string => !!l);
  const text = d.other.trim();
  return d.otherOn && text !== "" ? [...labels, text] : labels;
}

export const isAnswered = (q: Question, d: QuestionDraft): boolean => answerOf(q, d).length > 0;

export const isComplete = (qs: readonly Question[], ds: readonly QuestionDraft[]): boolean =>
  qs.every((q, i) => isAnswered(q, ds[i] ?? emptyDraft()));

export function toAnswers(qs: readonly Question[], ds: readonly QuestionDraft[]): QuestionAnswer[] {
  return qs.map((q, i) => ({ question: q.question, answers: answerOf(q, ds[i] ?? emptyDraft()) }));
}

/** The first question after `from` that has no answer yet, else null (Enter goes there). */
export function nextOpen(
  qs: readonly Question[],
  ds: readonly QuestionDraft[],
  from: number,
): number | null {
  for (let step = 1; step <= qs.length; step++) {
    const i = (from + step) % qs.length;
    if (i !== from && !isAnswered(qs[i]!, ds[i] ?? emptyDraft())) return i;
  }
  return null;
}
