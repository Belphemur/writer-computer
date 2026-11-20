import { useRef, useState } from "react";
import { HelpCircleIcon } from "@hugeicons/core-free-icons";
import { answerAgentQuestion } from "@features/agent/web/hooks/agent-api";
import type { Question } from "@features/agent/web/lib/events";
import {
  emptyDraft,
  isAnswered,
  isComplete,
  nextOpen,
  setOther,
  toAnswers,
  toggleOption,
  toggleOther,
  type QuestionDraft,
} from "@features/agent/web/lib/question-answers";
import type { QuestionState, ToolBlock } from "@features/agent/web/lib/transcript";
import { Ico } from "./agent-icon";

const CARD = "rounded-xl border bg-[var(--surface-card)] p-3 text-[13px] text-text-primary";

/**
 * A question the agent asks the user, in the transcript where its tool call is (spec 6.7). Open:
 * one tab per question when there are several, options as rows (radio or checkbox) plus an
 * "Other" text row, the focused option's preview below. Answered: a summary of the answers.
 * Keyboard (focus inside the card, never stolen from the composer): 1-9 picks, Space toggles in a
 * multi-select, Enter goes to the next open question and submits on the last, Esc skips.
 */
export function QuestionCard({ block }: { block: ToolBlock }) {
  const q = block.question!;
  return q.status === "pending" && q.requestId ? (
    <OpenQuestion state={q} requestId={q.requestId} />
  ) : (
    <QuestionSummary state={q} />
  );
}

function OpenQuestion({ state, requestId }: { state: QuestionState; requestId: string }) {
  const { questions } = state;
  const [drafts, setDrafts] = useState<QuestionDraft[]>(() => questions.map(emptyDraft));
  const [active, setActive] = useState(0);
  const [focused, setFocused] = useState(0);
  const cardRef = useRef<HTMLDivElement>(null);
  const q = questions[active]!;
  const draft = drafts[active] ?? emptyDraft();
  const complete = isComplete(questions, drafts);
  const preview = q.options[focused]?.preview;

  const patch = (fn: (d: QuestionDraft) => QuestionDraft) =>
    setDrafts((all) => all.map((d, i) => (i === active ? fn(d) : d)));
  const go = (i: number) => {
    setActive(i);
    setFocused(0);
  };
  const submit = () => void answerAgentQuestion(requestId, toAnswers(questions, drafts));
  const skip = () => void answerAgentQuestion(requestId, null);
  const advance = () => {
    if (!isAnswered(q, draft)) return;
    const next = nextOpen(questions, drafts, active);
    if (next !== null) go(next);
    else if (complete) submit();
  };

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      skip();
    } else if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement) && !e.shiftKey) {
      e.preventDefault();
      advance();
    } else if (
      /^[1-9]$/.test(e.key) &&
      !(e.target instanceof HTMLInputElement && e.target.type === "text")
    ) {
      const i = Number(e.key) - 1;
      if (i < q.options.length) {
        e.preventDefault();
        setFocused(i);
        patch((d) => toggleOption(q, d, i));
      }
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      // radios move on their own; the checkboxes of a multi-select move focus the same way
      const inputs = [
        ...(cardRef.current?.querySelectorAll<HTMLInputElement>(
          "[data-question-options] input:not([type=text])",
        ) ?? []),
      ];
      const at = inputs.indexOf(e.target as HTMLInputElement);
      if (at >= 0 && q.multiSelect) {
        e.preventDefault();
        inputs[
          Math.max(0, Math.min(inputs.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)))
        ]?.focus();
      }
    }
  }

  const kind = q.multiSelect ? "checkbox" : "radio";
  return (
    <div
      ref={cardRef}
      role="group"
      aria-label="Question"
      data-agent-question="pending"
      onKeyDown={onKeyDown}
      className={`${CARD} border-[var(--focus-border)]`}
    >
      <div className="flex items-center gap-2 font-medium">
        <Ico icon={HelpCircleIcon} size={15} className="text-text-icon-muted" />
        <span>Question</span>
        {state.by && (
          <span className="rounded-full bg-[var(--surface-subtle)] px-1.5 py-0.5 text-[11px] font-normal text-text-muted">
            asked by {state.by}
          </span>
        )}
        {questions.length > 1 && (
          <span data-question-progress className="ml-auto text-[11px] font-normal text-text-muted">
            {active + 1}/{questions.length}
          </span>
        )}
      </div>

      {questions.length > 1 ? (
        <div role="tablist" aria-label="Questions" className="mt-2 flex flex-wrap gap-1">
          {questions.map((x, i) => (
            <button
              key={i}
              type="button"
              role="tab"
              aria-selected={i === active}
              data-answered={isAnswered(x, drafts[i] ?? emptyDraft())}
              onClick={() => go(i)}
              className={`rounded-full px-2 py-0.5 text-[11.5px] ${
                i === active
                  ? "bg-[var(--surface-selected)] text-text-primary"
                  : "bg-[var(--surface-subtle)] text-text-muted hover:text-text-primary"
              }`}
            >
              {x.header || `Question ${i + 1}`}
              {isAnswered(x, drafts[i] ?? emptyDraft()) ? " ✓" : ""}
            </button>
          ))}
        </div>
      ) : (
        q.header && (
          <span className="mt-2 inline-block rounded-full bg-[var(--surface-subtle)] px-2 py-0.5 text-[11.5px] text-text-muted">
            {q.header}
          </span>
        )
      )}

      <p className="mt-2 break-words" data-question-text>
        {q.question}
      </p>
      <div
        data-question-options
        role={q.multiSelect ? "group" : "radiogroup"}
        aria-label={q.question}
        className="mt-1.5 space-y-0.5"
      >
        {q.options.map((o, i) => (
          <label
            key={i}
            onMouseEnter={() => setFocused(i)}
            className="flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 hover:bg-[var(--item-hover-bg)]"
          >
            <input
              type={kind}
              name={`q-${requestId}-${active}`}
              checked={draft.picked.includes(i)}
              onChange={() => patch((d) => toggleOption(q, d, i))}
              onFocus={() => setFocused(i)}
              className="mt-0.5 accent-[var(--accent)]"
            />
            <span className="min-w-0">
              <span className="block break-words">{o.label}</span>
              {o.description && (
                <span className="block break-words text-[12px] text-text-muted">
                  {o.description}
                </span>
              )}
            </span>
          </label>
        ))}
        <label className="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-[var(--item-hover-bg)]">
          <input
            type={kind}
            name={`q-${requestId}-${active}`}
            aria-label="Other"
            checked={draft.otherOn}
            onChange={() => patch((d) => toggleOther(q, d))}
            onFocus={() => setFocused(-1)}
            className="accent-[var(--accent)]"
          />
          <input
            type="text"
            aria-label="Other answer"
            placeholder="Other"
            value={draft.other}
            onChange={(e) => patch((d) => setOther(q, d, e.target.value))}
            onFocus={() => setFocused(-1)}
            className="min-w-0 flex-1 rounded-md border border-[var(--line-subtle)] bg-[var(--surface-input)] px-2 py-0.5 text-[12.5px] outline-none focus:border-[var(--focus-border)]"
          />
        </label>
      </div>
      {preview && (
        <pre
          data-question-preview
          aria-label="Preview"
          className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-[var(--surface-subtle)] p-2 font-[var(--mono-font)] text-[12px]"
        >
          {preview}
        </pre>
      )}

      <div className="mt-2.5 flex items-center gap-1.5">
        <button
          type="button"
          disabled={!complete}
          onClick={submit}
          className="rounded-md bg-[var(--accent)] px-2.5 py-1 text-[12.5px] font-medium text-white enabled:hover:opacity-90 disabled:opacity-40"
        >
          Submit
        </button>
        <button
          type="button"
          onClick={skip}
          className="rounded-md border border-[var(--line-subtle)] px-2.5 py-1 text-[12.5px] hover:bg-[var(--item-hover-bg)]"
        >
          Skip
        </button>
        <span className="ml-auto text-[11px] text-text-muted">Enter next, Esc skips.</span>
      </div>
    </div>
  );
}

const ENDED_TEXT = { skipped: "Skipped", cancelled: "Not answered" } as const;

/** What the call ended as: each question with its answer, or "Skipped" / "Not answered". */
function QuestionSummary({ state }: { state: QuestionState }) {
  const answered = state.status === "answered";
  const text = (q: Question["question"]) => state.answers.find((a) => a.question === q);
  return (
    <div
      data-agent-question={state.status}
      className={`${CARD} border-[var(--line-subtle)] text-[12.5px]`}
    >
      <div className="flex items-center gap-2 text-text-muted">
        <Ico icon={HelpCircleIcon} size={14} />
        <span>
          {answered
            ? "Asked"
            : `Asked · ${ENDED_TEXT[state.status as "skipped"] ?? "Not answered"}`}
        </span>
      </div>
      {answered && (
        <dl className="mt-1.5 space-y-1">
          {(state.questions.length > 0
            ? state.questions.map((q) => q.question)
            : state.answers.map((a) => a.question)
          ).map((q) => (
            <div key={q}>
              <dt className="break-words text-text-muted">{q}</dt>
              <dd className="break-words">{text(q)?.answers.join(", ") || "—"}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
