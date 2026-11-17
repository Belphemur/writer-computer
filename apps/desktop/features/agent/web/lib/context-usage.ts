/**
 * Context-window usage of a chat: the one place that turns the CLI's usage numbers into
 * "how full is the context". The store selector (`useChatContext`), the composer's ring and the
 * popover all read `contextStatus`; nothing else computes a percentage or a level.
 *
 * Where the numbers come from:
 * - Used tokens: the latest API call's `input + cache read + cache creation` tokens (the prompt
 *   the model was just given, i.e. the conversation so far). It comes from the stream's
 *   message-scope `usage` (live, one per API call), else from the turn's `result.usage`, which the
 *   CLI sums over every call of the turn and so over-counts after tool loops (fallback only).
 * - Window: the CLI's own `result.modelUsage[model].contextWindow` once a turn has finished
 *   (`Chat.contextWindow`, the truth, includes the 1M variants); before that `contextWindowFor`.
 *   Unknown stays `null`: the ring is then indeterminate, never a guessed percentage.
 */
import type { Chat, ContextUsage } from "./transcript";

export type { ContextUsage };

/** Window sizes known without asking the CLI. Keep this the only model-to-window table.
 *  `claude-sonnet-5-5` is what a real session reported (golden `ok-turn`); a model not listed
 *  and without the `[1m]` suffix is unknown until its first turn finishes. */
const KNOWN_WINDOWS: Readonly<Record<string, number>> = {
  "claude-sonnet-5-5": 1_000_000,
};

const ONE_MILLION = 1_000_000;

/** Context window for a model id or alias (`opus[1m]` and `claude-opus-5-5[1m]` are 1M), or null. */
export function contextWindowFor(model: string | null | undefined): number | null {
  if (!model) return null;
  if (/\[1m\]$/i.test(model)) return ONE_MILLION;
  return KNOWN_WINDOWS[model] ?? null;
}

export type ContextLevel = "ok" | "warn" | "danger";

/** Below 60% nothing to say, 60 to 85% getting full, above 85% time to start over or compact. */
export const WARN_PERCENT = 60;
export const DANGER_PERCENT = 85;

export function contextLevel(percent: number | null): ContextLevel {
  if (percent === null || percent < WARN_PERCENT) return "ok";
  return percent <= DANGER_PERCENT ? "warn" : "danger";
}

export const contextTokensOf = (
  u: Pick<ContextUsage, "inputTokens" | "cacheReadTokens" | "cacheCreationTokens">,
) => u.inputTokens + u.cacheReadTokens + u.cacheCreationTokens;

export type ContextStatus = {
  /** Tokens in the context, null before any usage arrived (new chat). */
  used: number | null;
  window: number | null;
  /** Rounded, clamped to 0..100; null when used or window is unknown. */
  percent: number | null;
  /** Unrounded fill 0..1 for drawing; null when unknown. */
  fraction: number | null;
  level: ContextLevel;
  breakdown: ContextUsage | null;
};

/** `requestedModel` is the chat's chosen model, the last resort for the window before the CLI
 *  has reported one. */
export function contextStatus(
  chat: Pick<Chat, "contextUsage" | "contextWindow" | "reportedModel" | "session">,
  requestedModel?: string | null,
): ContextStatus {
  const breakdown = chat.contextUsage;
  const used = breakdown ? contextTokensOf(breakdown) : null;
  const window =
    chat.contextWindow ??
    contextWindowFor(chat.reportedModel) ??
    contextWindowFor(chat.session?.model) ??
    contextWindowFor(requestedModel);
  const raw = used !== null && window ? (used / window) * 100 : null;
  const percent = raw === null ? null : Math.min(100, Math.round(raw));
  return {
    used,
    window,
    percent,
    fraction: raw === null ? null : Math.min(1, raw / 100),
    level: contextLevel(raw),
    breakdown,
  };
}
