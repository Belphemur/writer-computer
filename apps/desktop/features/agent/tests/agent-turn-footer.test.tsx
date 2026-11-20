// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { TurnFooter, turnTokensText } from "@features/agent/web/components/turn-footer";
import type { Turn } from "@features/agent/web/lib/transcript";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const turn = (over: Partial<Turn> = {}): Turn =>
  ({
    id: "t",
    status: "completed",
    durationMs: 47_000,
    usage: {
      inputTokens: 10,
      cacheReadTokens: 1_190_000,
      cacheCreationTokens: 10_000,
      outputTokens: 6_000,
      costUsd: 1.39,
    },
    liveOutputTokens: 0,
    numTurns: 5,
    blocks: [],
    errors: [],
    ...over,
  }) as unknown as Turn;

describe("turn footer tokens", () => {
  it("shows requests and output, never the summed input", () => {
    expect(turnTokensText(turn())).toBe("5 requests · 6k out");
    expect(turnTokensText(turn({ numTurns: 1 }))).toBe("1 request · 6k out");
    expect(turnTokensText(turn({ numTurns: null }))).toBe("6k out");
    expect(turnTokensText(turn({ usage: null, liveOutputTokens: 900 }))).toBe("900 out");
    expect(turnTokensText(turn({ usage: null }))).toBeNull();
  });

  describe("rendered", () => {
    let host: HTMLElement | null = null;
    afterEach(() => {
      host?.remove();
      host = null;
    });

    it("has no 'in' count in the footer text", () => {
      host = document.createElement("div");
      document.body.append(host);
      act(() => createRoot(host!).render(<TurnFooter turn={turn()} />));
      expect(host.textContent).toBe("Worked for 47s· 5 requests · 6k out· $1.39");
      expect(host.textContent).not.toMatch(/\bin\b/);
    });
  });
});
