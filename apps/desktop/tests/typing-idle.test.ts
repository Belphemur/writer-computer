// One idle constant for "the user stopped typing": lint's fixes and the future sync apply use it.
import { expect, it } from "vite-plus/test";
import { TYPING_IDLE_MS } from "@/lib/typing-idle";
import { FIX_IDLE_MS } from "@features/lint/web/lib/fix";

it("lint's fix delay is the shared typing idle, 5 s", () => {
  expect(TYPING_IDLE_MS).toBe(5000);
  expect(FIX_IDLE_MS).toBe(TYPING_IDLE_MS);
});
