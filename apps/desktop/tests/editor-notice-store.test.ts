// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import {
  dismissEditorNotice,
  showEditorNotice,
  useEditorNoticeStore,
} from "../src/components/editor-area/editor-notice-store";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  dismissEditorNotice();
  vi.useRealTimers();
});

describe("editor notice store", () => {
  test("a plain notice goes away after the timer", () => {
    showEditorNotice("saved");
    expect(useEditorNoticeStore.getState().message).toBe("saved");
    vi.advanceTimersByTime(4100);
    expect(useEditorNoticeStore.getState().message).toBeNull();
  });

  test("a sticky notice survives the timer until it is dismissed", () => {
    showEditorNotice("limit", { sticky: true });
    vi.advanceTimersByTime(60_000);
    expect(useEditorNoticeStore.getState().message).toBe("limit");
    dismissEditorNotice();
    expect(useEditorNoticeStore.getState().message).toBeNull();
  });

  test("a sticky notice is not cleared by the timer of the notice before it", () => {
    showEditorNotice("first");
    vi.advanceTimersByTime(1000);
    showEditorNotice("limit", { sticky: true });
    vi.advanceTimersByTime(10_000);
    expect(useEditorNoticeStore.getState().message).toBe("limit");
  });
});
