// The status wording of a linked vault: Synced, Pending n, Syncing, Conflict n, Offline, Error,
// Paused and Local, in the order that decides which one wins.
import { describe, expect, it } from "vite-plus/test";
import { summarize } from "../web/lib/state";
import { baseStatus } from "./fixtures";

const linked = (patch = {}) => baseStatus({ remote: "origin", branch: "main", ...patch });
const failure = (offline: boolean) => ({ line: "line", details: "d", offline, kind: "other" });

describe("summarize a linked vault", () => {
  it("says Local without a remote and Synced with one", () => {
    expect(summarize(baseStatus())?.label).toBe("Local");
    expect(summarize(linked())?.label).toBe("Synced");
  });

  it("counts the unsaved changes and the unpushed commits as Pending", () => {
    const changes = [{ path: "a.md", kind: "edit" }] as never;
    expect(summarize(linked({ changes, ahead: 2 }))?.label).toBe("Pending 3");
    expect(summarize(baseStatus({ changes, ahead: 2 }))?.label).toBe("Pending 1");
  });

  it("says Syncing while a sync runs, before anything else about the sync", () => {
    const s = summarize(
      linked({ syncing: true, conflicts: [{}] as never, syncError: failure(false) }),
    );
    expect(s?.label).toBe("Syncing");
  });

  it("says Conflict n, then Offline or Error with the one-line reason", () => {
    expect(summarize(linked({ conflicts: [{}, {}] as never }))?.label).toBe("Conflict 2");
    expect(summarize(linked({ syncError: failure(true) }))).toMatchObject({
      label: "Offline",
      detail: "line",
    });
    expect(summarize(linked({ syncError: failure(false) }))).toMatchObject({
      label: "Error",
      tone: "error",
    });
  });

  it("says Paused for a paused sync and for a merge or a detached HEAD", () => {
    expect(summarize(linked({ syncPaused: true }))?.label).toBe("Paused");
    expect(summarize(linked({ operation: "merge" }))?.label).toBe("Paused");
  });
});
