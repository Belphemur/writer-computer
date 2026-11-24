// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({ get: async () => undefined, set: async () => {} })),
}));

import type { AgentClient } from "@features/agent/web/lib/client";
import type { AgentEvent } from "@features/agent/web/lib/events";
import { createMockAgentClient, type Goldens } from "@features/agent/web/lib/mock-client";
import {
  classifyStartError,
  configureAgentRuntimeForTests,
  configureRefIoForTests,
  toVaultRelative,
  useAgentStore,
} from "@features/agent/web/stores/agent-store";
import { AGENT_PANE_DEFAULT_WIDTH, usePaneStore } from "@features/agent/web/stores/pane-store";
import { useEditorStore } from "@/stores/editor-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { goldens } from "@features/agent/tests/helpers/agent-goldens";

const g = goldens as unknown as Goldens;
const get = () => useAgentStore.getState();
const chat = () => get().chats[get().activeChatId!]!;
const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const finishedEvent = (reason: "completed" | "interrupted"): AgentEvent => ({
  type: "turn-finished",
  reason,
  durationMs: 1,
  apiDurationMs: null,
  numTurns: 1,
  isError: false,
  result: null,
  sessionId: null,
  errors: [],
});

let mock: ReturnType<typeof createMockAgentClient>;
beforeEach(() => {
  mock = createMockAgentClient({ goldens: g });
  configureAgentRuntimeForTests(mock);
  usePaneStore.setState({ open: false, width: AGENT_PANE_DEFAULT_WIDTH });
  useAgentStore.setState({
    chats: {},
    order: [],
    activeChatId: null,
    drafts: {},
    queued: {},
    written: {},
    modes: {},
    view: "chat",
    backend: "tauri",
    binaries: {},
    currentProjectPath: null,
  });
});

describe("agent store: panes and tabs", () => {
  it("opening the pane creates a first chat and asks for composer focus", () => {
    const tick = get().focusComposerTick;
    get().openPane();
    expect(usePaneStore.getState().open).toBe(true);
    expect(get().order).toHaveLength(1);
    expect(get().focusComposerTick).toBeGreaterThan(tick);
    get().togglePane();
    expect(usePaneStore.getState().open).toBe(false);
    get().togglePane();
    expect(get().order).toHaveLength(1);
  });

  it("new chats take the current project; closing the last tab leaves a fresh one", () => {
    useAgentStore.setState({ currentProjectPath: "Projects/Demo" });
    const id = get().newChat();
    expect(get().chats[id]!.projectPath).toBe("Projects/Demo");
    get().closeChat(id);
    expect(get().order).toHaveLength(1);
    expect(get().activeChatId).toBe(get().order[0]);
  });

  it("switching project reuses an untouched chat, but starts a new one once it has content", () => {
    const first = get().newChat("Projects/A");
    const reused = get().newChat("Projects/B");
    expect(reused).toBe(first);
    expect(get().order.filter((id) => id === first)).toHaveLength(1);
    expect(get().chats[first]!.projectPath).toBe("Projects/B");
    expect(get().notes[first]!.meta.projectPath).toBe("Projects/B");
    get().setDraft(first, { text: "half-written" });
    const next = get().newChat("Projects/C");
    expect(next).not.toBe(first);
    expect(get().chats[first]!.projectPath).toBe("Projects/B");
    expect(get().newChat()).not.toBe(next);
  });

  it("cycles tabs and clamps the width", () => {
    const a = get().newChat();
    const b = get().newChat();
    expect(get().activeChatId).toBe(b);
    get().cycleChat(1);
    expect(get().activeChatId).toBe(a);
    get().cycleChat(-1);
    expect(get().activeChatId).toBe(b);
    usePaneStore.getState().setWidth(5000);
    expect(usePaneStore.getState().width).toBe(900);
    usePaneStore.getState().setWidth(10);
    expect(usePaneStore.getState().width).toBe(320);
  });
});

describe("agent store: a turn against the recorded backend", () => {
  it("send: optimistic user card, spawn, stream, complete, back to idle", async () => {
    get().openPane();
    const id = get().activeChatId!;
    const sent = get().sendMessage("hello there");
    expect(chat().turns[0]!.user?.text).toBe("hello there");
    expect(chat().state).toBe("starting");
    await sent;
    await mock.idle(id);
    await settle();
    expect(chat().state).toBe("idle");
    expect(chat().turns[0]!.status).toBe("completed");
    expect(chat().title).toBe("hello there");
    expect(chat().lastSeq).toBeGreaterThan(3);
    expect(get().drafts[id]!.text).toBe("");
  });

  it("a permission pauses the chat; Allow resumes it", async () => {
    get().openPane();
    const id = get().activeChatId!;
    await get().sendMessage("write a file");
    await vi.waitFor(() => expect(chat().state).toBe("awaiting-permission"));
    const req = chat().pendingPermissions[0]!;
    expect(req.tool).toBe("Write");
    await get().decidePermission(req.requestId, "allow");
    await vi.waitFor(() => expect(chat().pendingPermissions[0]?.tool).toBe("Bash"));
    await get().decidePermission(chat().pendingPermissions[0]!.requestId, "deny");
    await mock.idle(id);
    await settle();
    expect(chat().state).toBe("idle");
    expect(chat().turns[0]!.status).toBe("completed");
  });

  it("stop while a card is pending: cancelling, then the capture's interrupted ending", async () => {
    get().openPane();
    const id = get().activeChatId!;
    await get().sendMessage("stop");
    await vi.waitFor(() => expect(chat().state).toBe("awaiting-permission"));
    const stopping = get().stop();
    expect(chat().state).toBe("cancelling");
    await stopping;
    await mock.idle(id);
    await settle();
    expect(chat().state).toBe("idle");
    expect(chat().turns[0]!.status).toBe("interrupted");
  });

  it("a message sent while running is queued, merged, and sent when the turn ends", async () => {
    get().openPane();
    const id = get().activeChatId!;
    await get().sendMessage("write");
    await vi.waitFor(() => expect(chat().state).toBe("awaiting-permission"));
    await get().sendMessage("second");
    await get().sendMessage("third");
    expect(get().queued[id]!.text).toBe("second\n\nthird");
    expect(chat().turns).toHaveLength(1);
    // finish the first turn
    await get().decidePermission(chat().pendingPermissions[0]!.requestId, "allow");
    await vi.waitFor(() => expect(chat().pendingPermissions[0]?.tool).toBe("Bash"));
    await get().decidePermission(chat().pendingPermissions[0]!.requestId, "allow");
    await vi.waitFor(() => expect(chat().turns).toHaveLength(2));
    expect(chat().turns[1]!.user?.text).toBe("second\n\nthird");
    expect(get().queued[id]).toBeUndefined();
    await mock.idle(id);
  });

  it("a session reload mid-turn keeps the chip; Rust sends the line again and its receipt places the card once", async () => {
    get().openPane();
    const id = get().activeChatId!;
    await get().sendMessage("write");
    await vi.waitFor(() => expect(chat().state).toBe("awaiting-permission"));
    await get().sendMessage("second");
    await get().sendMessage("third");
    const chipId = get().queued[id]!.id!;
    const send = vi.spyOn(mock, "send");
    const queue = vi.spyOn(mock, "queue");
    // Rust replaced the process (a config change or "Reload session"): the event touches no chip
    get().ingest(id, [{ type: "session-reloaded", reason: "skill writer-graph changed" }], 100);
    expect(get().queued[id]!.text).toBe("second\n\nthird");
    // the turn ends: the new process runs the line it was handed again (Rust owns that resend,
    // keeping the receipt id), the web hands nothing over
    get().ingest(id, [finishedEvent("completed")], 101);
    expect(get().queued[id]!.id).toBe(chipId);
    await settle(20);
    expect(send).not.toHaveBeenCalled();
    expect(queue).not.toHaveBeenCalled();
    get().ingest(id, [{ type: "message-received", messageId: chipId }], 102);
    expect(get().queued[id]).toBeUndefined();
    // a second receipt (nothing waits for it any more) adds nothing
    get().ingest(id, [{ type: "message-received", messageId: chipId }], 103);
    expect(chat().turns.filter((t) => t.user?.text === "second\n\nthird")).toHaveLength(1);
  });

  describe("steer (Cmd+Enter)", () => {
    async function awaitingPermission() {
      get().openPane();
      const id = get().activeChatId!;
      await get().sendMessage("write");
      await vi.waitFor(() => expect(chat().state).toBe("awaiting-permission"));
      return id;
    }
    const finish = async (id: string) => {
      await get().stop();
      await mock.idle(id);
    };

    it("with text, goes into the running turn at once, as a card at that point, never queued", async () => {
      const id = await awaitingPermission();
      const send = vi.spyOn(mock, "send");
      const steer = vi.spyOn(mock, "steer");
      await get().sendNow("take the other file");
      expect(steer).toHaveBeenCalledTimes(1);
      expect(steer.mock.calls[0]![0]).toMatchObject({ chatId: id });
      expect(steer.mock.calls[0]![0].text).toContain("take the other file");
      expect(send).not.toHaveBeenCalled();
      expect(get().queued[id]).toBeUndefined();
      expect(chat().turns).toHaveLength(1);
      const last = chat().turns[0]!.blocks.at(-1)!;
      expect(last).toMatchObject({ kind: "steer", message: { text: "take the other file" } });
      await finish(id);
    });

    it("with an empty composer sends the queued messages now, merged, and clears the chip", async () => {
      const id = await awaitingPermission();
      await get().sendMessage("second");
      await get().sendMessage("third");
      expect(get().queued[id]!.text).toBe("second\n\nthird");
      const steer = vi.spyOn(mock, "steer");
      await get().sendNow("");
      expect(steer).toHaveBeenCalledTimes(1);
      expect(steer.mock.calls[0]![0].text).toContain("second\n\nthird");
      expect(get().queued[id]).toBeUndefined();
      expect(chat().turns[0]!.blocks.at(-1)).toMatchObject({
        kind: "steer",
        message: { text: "second\n\nthird" },
      });
      await finish(id);
    });

    it("leaves the queue alone when the composer has text", async () => {
      const id = await awaitingPermission();
      await get().sendMessage("later");
      await get().sendNow("now");
      expect(get().queued[id]!.text).toBe("later");
      await finish(id);
    });

    it("while idle is a plain send, and does nothing with nothing to send", async () => {
      get().openPane();
      const id = get().activeChatId!;
      const send = vi.spyOn(mock, "send");
      const steer = vi.spyOn(mock, "steer");
      await get().sendNow("");
      expect(send).not.toHaveBeenCalled();
      await get().sendNow("hello");
      expect(send).toHaveBeenCalledTimes(1);
      expect(steer).not.toHaveBeenCalled();
      expect(chat().turns[0]!.user?.text).toBe("hello");
      await mock.idle(id);
    });

    it("does nothing while the chat is stopping: the composer is off, nothing is steered or queued", async () => {
      const id = await awaitingPermission();
      const steer = vi.spyOn(mock, "steer");
      const stopping = get().stop();
      expect(chat().state).toBe("cancelling");
      await get().sendNow("too late");
      expect(steer).not.toHaveBeenCalled();
      expect(get().queued[id]).toBeUndefined();
      await stopping;
      await mock.idle(id);
      expect(chat().turns).toHaveLength(1);
    });
  });

  describe("Enter while a turn runs (a plain line the CLI takes at its next tool call)", () => {
    async function awaitingPermission() {
      get().openPane();
      const id = get().activeChatId!;
      await get().sendMessage("write");
      await vi.waitFor(() => expect(chat().state).toBe("awaiting-permission"));
      return id;
    }
    const finish = async (id: string) => {
      await get().stop();
      await mock.idle(id);
    };

    it("is written to the CLI at once, not held, and shows as the chip with no card yet", async () => {
      const id = await awaitingPermission();
      const send = vi.spyOn(mock, "send");
      const queue = vi.spyOn(mock, "queue");
      await get().sendMessage("also the tagged ones");
      expect(queue).toHaveBeenCalledTimes(1);
      expect(queue.mock.calls[0]![0]).toMatchObject({ chatId: id });
      expect(queue.mock.calls[0]![0].text).toContain("also the tagged ones");
      expect(send).not.toHaveBeenCalled();
      const chip = get().queued[id]!;
      expect(chip).toMatchObject({
        text: "also the tagged ones",
        id: queue.mock.calls[0]![0].messageId,
      });
      expect(chat().turns).toHaveLength(1);
      expect(chat().turns[0]!.blocks.some((b) => b.kind === "steer")).toBe(false);
      await finish(id);
    });

    it("the chip stays until the receipt; then the card sits inside the running turn, with no Steer", async () => {
      const id = await awaitingPermission();
      await get().sendMessage("also the tagged ones");
      const chipId = get().queued[id]!.id!;
      get().ingest(id, [], 50);
      expect(get().queued[id]).toBeDefined();
      get().ingest(id, [{ type: "message-received", messageId: chipId }], 60);
      expect(get().queued[id]).toBeUndefined();
      expect(get().written[chipId]).toBeUndefined();
      expect(chat().turns).toHaveLength(1);
      expect(chat().turns[0]!.blocks.at(-1)).toMatchObject({
        kind: "steer",
        injected: true,
        message: { text: "also the tagged ones" },
      });
      await finish(id);
    });

    it("a message the CLI ran after the turn is the next turn's user card", async () => {
      const id = await awaitingPermission();
      await get().sendMessage("one more thing");
      const chipId = get().queued[id]!.id!;
      get().ingest(id, [finishedEvent("completed")], 50);
      // written to the CLI: it is not sent again and the chip waits for the receipt
      expect(get().queued[id]!.id).toBe(chipId);
      await settle(10);
      expect(chat().turns).toHaveLength(1);
      get().ingest(id, [{ type: "message-received", messageId: chipId }], 60);
      expect(chat().turns).toHaveLength(2);
      expect(chat().turns[1]!.user?.text).toBe("one more thing");
      expect(chat().state).toBe("running");
      expect(get().queued[id]).toBeUndefined();
      await finish(id);
    });

    it("two messages before the CLI took the first are one message, one chip, with a new id", async () => {
      const id = await awaitingPermission();
      const queue = vi.spyOn(mock, "queue");
      const unqueue = vi.spyOn(mock, "unqueue");
      await get().sendMessage("second");
      const first = get().queued[id]!.id!;
      await get().sendMessage("third");
      expect(unqueue).toHaveBeenCalledWith({ chatId: id, messageId: first });
      expect(queue).toHaveBeenCalledTimes(2);
      const merged = queue.mock.calls[1]![0];
      expect(merged.text).toContain("second\n\nthird");
      expect(merged.messageId).not.toBe(first);
      expect(get().queued[id]).toMatchObject({ text: "second\n\nthird", id: merged.messageId });
      expect(Object.keys(get().written)).toEqual([merged.messageId]);
      await finish(id);
    });

    it("a first message the CLI already took keeps its own card; the new text waits on its own", async () => {
      const id = await awaitingPermission();
      await get().sendMessage("second");
      const first = get().queued[id]!.id!;
      vi.spyOn(mock, "unqueue").mockResolvedValueOnce(false);
      await get().sendMessage("third");
      const chip = get().queued[id]!;
      expect(chip.text).toBe("third");
      expect(chip.id).not.toBe(first);
      // the receipt of the first still finds its text
      get().ingest(id, [{ type: "message-received", messageId: first }], 60);
      expect(chat().turns[0]!.blocks.at(-1)).toMatchObject({
        injected: true,
        message: { text: "second" },
      });
      expect(get().queued[id]!.text).toBe("third");
      await finish(id);
    });

    /** An `unqueue` that answers when told: the chip is looked at while the CLI is asked. */
    function slowUnqueue(answer: boolean) {
      let release: () => void = () => undefined;
      const spy = vi.spyOn(mock, "unqueue").mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            release = () => resolve(answer);
          }),
      );
      return {
        spy,
        // the request reaches the client a tick after Enter (the runtime is awaited first)
        answer: async () => {
          await vi.waitFor(() => expect(spy).toHaveBeenCalled());
          release();
        },
      };
    }

    it("the chip shows the merged text at once, while the CLI is still asked, then holds the same text", async () => {
      const id = await awaitingPermission();
      const queue = vi.spyOn(mock, "queue");
      await get().sendMessage("first");
      const first = get().queued[id]!.id!;
      const asked = slowUnqueue(true);
      const second = get().sendMessage("second");
      // before any answer: merged, still keyed by the line the CLI has
      expect(get().queued[id]).toMatchObject({ text: "first\n\nsecond", id: first });
      const third = get().sendMessage("third");
      expect(get().queued[id]!.text).toBe("first\n\nsecond\n\nthird");
      await asked.answer();
      await Promise.all([second, third]);
      // one more line only: the CLI saw "first", then one merged line with all three
      expect(queue).toHaveBeenCalledTimes(2);
      expect(queue.mock.calls[1]![0].text).toContain("first\n\nsecond\n\nthird");
      expect(asked.spy).toHaveBeenCalledTimes(1);
      expect(get().queued[id]).toMatchObject({
        text: "first\n\nsecond\n\nthird",
        id: queue.mock.calls[1]![0].messageId,
      });
      expect(get().queued[id]!.tail).toBeUndefined();
      expect(Object.keys(get().written)).toEqual([queue.mock.calls[1]![0].messageId]);
      await finish(id);
    });

    it("three Enters one after the other show first, first+second, first+second+third", async () => {
      const id = await awaitingPermission();
      const seen: string[] = [];
      for (const text of ["a", "b", "c"]) {
        await get().sendMessage(text);
        seen.push(get().queued[id]!.text);
      }
      expect(seen).toEqual(["a", "a\n\nb", "a\n\nb\n\nc"]);
      await finish(id);
    });

    it("when the CLI took the first line during the merge, it keeps its card and the rest is the chip", async () => {
      const id = await awaitingPermission();
      await get().sendMessage("first");
      const first = get().queued[id]!.id!;
      const asked = slowUnqueue(false);
      const second = get().sendMessage("second");
      const third = get().sendMessage("third");
      expect(get().queued[id]!.text).toBe("first\n\nsecond\n\nthird");
      // the receipt of the first arrives before the answer: only what it did not hold is left
      await vi.waitFor(() => expect(asked.spy).toHaveBeenCalled());
      get().ingest(id, [{ type: "message-received", messageId: first }], 60);
      expect(get().queued[id]).toMatchObject({ text: "second\n\nthird", id: null });
      expect(chat().turns[0]!.blocks.at(-1)).toMatchObject({
        injected: true,
        message: { text: "first" },
      });
      await asked.answer();
      await Promise.all([second, third]);
      // held in Writer until the chat is idle; never shown stale
      expect(get().queued[id]).toMatchObject({ text: "second\n\nthird", id: null });
      await finish(id);
    });

    it("a refused cancel (the answer comes before the receipt) writes the rest as its own chip", async () => {
      const id = await awaitingPermission();
      const queue = vi.spyOn(mock, "queue");
      await get().sendMessage("first");
      const first = get().queued[id]!.id!;
      const asked = slowUnqueue(false);
      const second = get().sendMessage("second");
      expect(get().queued[id]!.text).toBe("first\n\nsecond");
      await asked.answer();
      await second;
      expect(get().queued[id]).toMatchObject({ text: "second" });
      expect(get().queued[id]!.id).toBe(queue.mock.calls[1]![0].messageId);
      // the first line's receipt still finds its text and leaves the new chip alone
      get().ingest(id, [{ type: "message-received", messageId: first }], 60);
      expect(chat().turns[0]!.blocks.at(-1)).toMatchObject({ message: { text: "first" } });
      expect(get().queued[id]!.text).toBe("second");
      // no stale chip after the receipt of the new line either
      get().ingest(
        id,
        [{ type: "message-received", messageId: queue.mock.calls[1]![0].messageId }],
        61,
      );
      expect(get().queued[id]).toBeUndefined();
      expect(get().written).toEqual({});
      await finish(id);
    });

    for (const answer of [true, false]) {
      it(`removing the chip while a merge waits for the CLI (answer ${answer}) never brings text back`, async () => {
        const id = await awaitingPermission();
        const queue = vi.spyOn(mock, "queue");
        await get().sendMessage("first");
        const first = get().queued[id]!.id!;
        const asked = slowUnqueue(answer);
        const second = get().sendMessage("second");
        expect(get().queued[id]!.text).toBe("first\n\nsecond");
        const removed = get().removeQueued(id);
        await asked.answer();
        await Promise.all([second, removed]);
        // B was never written; A is gone (cancelled) or kept as the line the CLI took
        expect(queue).toHaveBeenCalledTimes(1);
        if (answer) {
          expect(get().queued[id]).toBeUndefined();
          expect(get().written).toEqual({});
        } else {
          expect(get().queued[id]).toMatchObject({ text: "first", id: first });
          get().ingest(id, [{ type: "message-received", messageId: first }], 60);
          expect(get().queued[id]).toBeUndefined();
          expect(chat().turns[0]!.blocks.at(-1)).toMatchObject({ message: { text: "first" } });
        }
        await finish(id);
      });
    }

    it("quick Enters are handled one after the other", async () => {
      const id = await awaitingPermission();
      const queue = vi.spyOn(mock, "queue");
      await Promise.all([get().sendMessage("a"), get().sendMessage("b"), get().sendMessage("c")]);
      expect(get().queued[id]!.text).toBe("a\n\nb\n\nc");
      expect(Object.keys(get().written)).toHaveLength(1);
      expect(queue.mock.calls.at(-1)![0].text).toContain("a\n\nb\n\nc");
      await finish(id);
    });

    it("removing the chip before the receipt takes the line back and drops it", async () => {
      const id = await awaitingPermission();
      await get().sendMessage("never mind");
      const chipId = get().queued[id]!.id!;
      const unqueue = vi.spyOn(mock, "unqueue");
      await get().removeQueued(id);
      expect(unqueue).toHaveBeenCalledWith({ chatId: id, messageId: chipId });
      expect(get().queued[id]).toBeUndefined();
      expect(get().written).toEqual({});
      await finish(id);
      // it never ran
      expect(chat().turns).toHaveLength(1);
    });

    it("a line the CLI already took cannot be removed: the chip stays until the receipt", async () => {
      const id = await awaitingPermission();
      await get().sendMessage("too late");
      vi.spyOn(mock, "unqueue").mockResolvedValueOnce(false);
      await get().removeQueued(id);
      expect(get().queued[id]).toBeDefined();
      await finish(id);
    });

    it("a line the CLI lost goes back to waiting in Writer and is sent as an ordinary message when idle", async () => {
      const id = await awaitingPermission();
      await get().sendMessage("lost one");
      const chipId = get().queued[id]!.id!;
      const send = vi.spyOn(mock, "send");
      get().ingest(id, [{ type: "steer-undelivered", messageId: chipId }], 50);
      expect(get().queued[id]).toMatchObject({ text: "lost one", id: null });
      expect(send).not.toHaveBeenCalled(); // not idle yet
      get().ingest(id, [finishedEvent("interrupted")], 51);
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
      expect(send.mock.calls[0]![0].text).toContain("lost one");
      expect(get().queued[id]).toBeUndefined();
    });

    it("stopping hands the waiting line back and it goes out after the stop", async () => {
      const id = await awaitingPermission();
      await get().sendMessage("after the stop");
      const send = vi.spyOn(mock, "send");
      await get().stop();
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
      expect(send.mock.calls[0]![0].text).toContain("after the stop");
      expect(get().queued[id]).toBeUndefined();
      await settle(10);
      await get().stop();
    });

    it("a write that fails leaves the running turn alone and the message waiting in Writer", async () => {
      const id = await awaitingPermission();
      vi.spyOn(mock, "queue").mockRejectedValueOnce(new Error("pipe closed"));
      await get().sendMessage("will fail");
      expect(get().queued[id]).toMatchObject({ text: "will fail", id: null });
      expect(chat().state).toBe("awaiting-permission");
      expect(chat().error).toBeNull();
      await finish(id);
    });

    it("Cmd+Enter with an empty composer takes the waiting line back and steers it", async () => {
      const id = await awaitingPermission();
      await get().sendMessage("now please");
      const steer = vi.spyOn(mock, "steer");
      await get().sendNow("");
      expect(steer).toHaveBeenCalledTimes(1);
      expect(steer.mock.calls[0]![0].text).toContain("now please");
      expect(get().queued[id]).toBeUndefined();
      expect(get().written).toEqual({});
      await finish(id);
    });

    it("while idle there is no line to write: an ordinary send", async () => {
      get().openPane();
      const id = get().activeChatId!;
      const send = vi.spyOn(mock, "send");
      const queue = vi.spyOn(mock, "queue");
      await get().sendMessage("hello");
      expect(send).toHaveBeenCalledTimes(1);
      expect(queue).not.toHaveBeenCalled();
      await mock.idle(id);
    });
  });

  it("removing the queued chip drops it", async () => {
    get().openPane();
    const id = get().activeChatId!;
    await get().sendMessage("write");
    await vi.waitFor(() => expect(chat().state).toBe("awaiting-permission"));
    await get().sendMessage("later");
    await get().removeQueued(id);
    expect(get().queued[id]).toBeUndefined();
    await get().stop();
    await mock.idle(id);
  });

  it("the active-note chip and mentions travel as context and are consumed", async () => {
    get().openPane();
    const id = get().activeChatId!;
    const send = vi.spyOn(mock, "send");
    get().setDraft(id, {
      text: "see @a.md",
      mentions: [{ kind: "note", path: "a.md" }],
      activeNote: false,
    });
    await get().sendMessage("see @a.md");
    expect(send.mock.calls[0]![0].context).toEqual([{ kind: "note", path: "a.md" }]);
    expect(get().drafts[id]!.mentions).toEqual([]);
    await mock.idle(id);
  });

  describe("what claude receives", () => {
    const setActive = (rel: string | null) =>
      useEditorStore.setState({ activeFilePath: rel ? `/v/${rel}` : null } as never);
    beforeEach(() => useWorkspaceStore.setState({ root: "/v" } as never));

    async function sendDraft(text: string, mentions = [] as never[]) {
      get().openPane();
      const id = get().activeChatId!;
      const send = vi.spyOn(mock, "send");
      get().setDraft(id, { text, mentions, activeNote: false });
      await get().sendMessage(text);
      await mock.idle(id);
      return { id, sent: send.mock.calls[0]![0] };
    }

    it("sends the prompt with @activenote resolved now, the card keeps what was typed", async () => {
      setActive("Notes/Today.md");
      const { id, sent } = await sendDraft("compare @Projects/Plan.md with @activenote", [
        { kind: "note", path: "Projects/Plan.md" } as never,
      ]);
      expect(
        sent.text.startsWith("compare @Projects/Plan.md with @Notes/Today.md\n\n<references>"),
      ).toBe(true);
      expect(sent.text).toContain("- @Notes/Today.md (active note");
      expect(get().chats[id]!.turns[0]!.user!.text).toBe(
        "compare @Projects/Plan.md with @activenote",
      );
      expect(get().notes[id]!.messages[0]!.text).toBe("compare @Projects/Plan.md with @activenote");
      expect(sent.context).toContainEqual({
        kind: "active-note",
        path: "Notes/Today.md",
        inline: false,
      });
    });

    it("follows a rename of the active note between composing and sending", async () => {
      setActive("Old.md");
      get().openPane();
      const id = get().activeChatId!;
      get().setDraft(id, { text: "fix @activenote", activeNote: true });
      setActive("Renamed.md");
      const send = vi.spyOn(mock, "send");
      await get().sendMessage("fix @activenote");
      await mock.idle(id);
      expect(send.mock.calls[0]![0].text).toMatch(/^fix @Renamed\.md\n/);
    });

    it("sends the full path for a note picked by its readable name, following a rename", async () => {
      setActive(null);
      get().openPane();
      const id = get().activeChatId!;
      const NAME = "Daniel Wierdsma Staff Timing and Growth Plan";
      const NEW = `Management/Meeting Preps/2026/11/2026-11-16 - ${NAME}.md`;
      configureRefIoForTests({
        exists: async (p: string) => p === NEW,
        findByName: async (n: string) => (n === "Plan.md" ? [NEW] : []),
      });
      const send = vi.spyOn(mock, "send");
      get().setDraft(id, { mentions: [{ kind: "note", path: "Old/Plan.md", label: NAME }] });
      await get().sendMessage(`prep @"${NAME}"`);
      await mock.idle(id);
      configureRefIoForTests(null);
      // the recorded path is gone: its file name resolved to the renamed file at send time
      expect(send.mock.calls[0]![0].text.startsWith(`prep @"${NEW}"\n`)).toBe(true);
      expect(send.mock.calls[0]![0].text).toContain(`- @"${NEW}" (note)`);
      expect(get().chats[id]!.turns[0]!.user!.text).toBe(`prep @"${NAME}"`);
    });

    it("leaves a hand-typed bare name literal and resolves an exact typed path", async () => {
      setActive(null);
      configureRefIoForTests({
        exists: async (p: string) => p === "Notes/Solo.md",
        findByName: async () => [],
      });
      const { sent } = await sendDraft("read @Solo and @Notes/Solo.md");
      configureRefIoForTests(null);
      expect(sent.text.startsWith("read @Solo and @Notes/Solo.md\n")).toBe(true);
      expect(sent.text).toContain("- @Notes/Solo.md (note)");
      expect(sent.text.match(/^- /gm)).toHaveLength(1); // @Solo has no entry
    });

    it("keeps @activenote literal, with no footer, when no note is open", async () => {
      setActive(null);
      const { sent } = await sendDraft("fix @activenote");
      expect(sent.text).toBe("fix @activenote");
      expect(sent.context).toEqual([]);
    });

    it("sends cwd-relative paths in a project chat", async () => {
      setActive(null);
      get().openPane();
      const id = get().activeChatId!;
      useAgentStore.setState((st) => ({
        chats: { ...st.chats, [id]: { ...st.chats[id]!, projectPath: "Projects/A" } },
      }));
      const send = vi.spyOn(mock, "send");
      get().setDraft(id, { mentions: [{ kind: "note", path: "Notes/My Note.md" }] });
      await get().sendMessage('read @"Notes/My Note.md"');
      await mock.idle(id);
      expect(send.mock.calls[0]![0].text.startsWith('read @"../../Notes/My Note.md"\n')).toBe(true);
    });
  });

  describe("open tabs footer", () => {
    const tabsOf = (...paths: string[]) =>
      useEditorStore.setState({
        tabs: paths.map((p, i) => ({
          id: `t${i}`,
          location: { kind: "file", path: `/v/${p}` },
          back: [],
          forward: [],
        })),
        activeTabId: "t0",
        openFiles: new Map(),
      } as never);
    beforeEach(() => {
      useWorkspaceStore.setState({ root: "/v" } as never);
      useSettingsStore.setState({ settings: {} } as never);
    });
    afterEach(() => {
      useEditorStore.setState({ tabs: [], activeTabId: null } as never);
      useSettingsStore.setState({ settings: {} } as never);
    });

    async function turn(id: string, text: string) {
      const send = vi.spyOn(mock, "send");
      get().setDraft(id, { text, mentions: [], activeNote: false });
      await get().sendMessage(text);
      await mock.idle(id);
      return send.mock.calls[send.mock.calls.length - 1]![0].text;
    }

    it("sends the tabs on the first turn, skips them while unchanged, resends on change", async () => {
      tabsOf("a.md", "My Plan.md");
      get().openPane();
      const id = get().activeChatId!;
      const first = await turn(id, "one");
      expect(first).toContain("<open-tabs>");
      expect(first).toContain('- "a.md" (active; note)');
      expect(first).toContain('- "My Plan.md" (note)');
      expect(await turn(id, "two")).not.toContain("<open-tabs>");
      tabsOf("a.md", "My Plan.md", "c.md");
      expect(await turn(id, "three")).toContain('- "c.md" (note)');
    });

    it("resends when a tag changes in an open note", async () => {
      tabsOf("a.md");
      get().openPane();
      const id = get().activeChatId!;
      const files = (fm: string) =>
        useEditorStore.setState({
          openFiles: new Map([["/v/a.md", { frontmatter: fm }]]),
        } as never);
      files("tags: [x]");
      expect(await turn(id, "one")).toContain("tags: x");
      expect(await turn(id, "two")).not.toContain("<open-tabs>");
      files("tags: [x, y]");
      expect(await turn(id, "three")).toContain("tags: x, y");
    });

    it("is off with agent.share-open-tabs false, and absent with no file tabs", async () => {
      useSettingsStore.setState({ settings: { "agent.share-open-tabs": false } } as never);
      tabsOf("a.md");
      get().openPane();
      const id = get().activeChatId!;
      expect(await turn(id, "one")).not.toContain("<open-tabs>");
      useSettingsStore.setState({ settings: {} } as never);
      tabsOf();
      expect(await turn(id, "two")).not.toContain("<open-tabs>");
    });
  });

  it("passes the per-chat permission mode to the session start", async () => {
    get().openPane();
    const id = get().activeChatId!;
    const start = vi.spyOn(mock, "start");
    await get().setPermissionMode("plan");
    expect(get().modes[id]).toBe("plan");
    await get().sendMessage("hi");
    expect(start.mock.calls[0]![0].settings.permissionMode).toBe("plan");
    await mock.idle(id);
  });
});

describe("agent store: failures", () => {
  const failing = (error: unknown): AgentClient => ({
    ...createMockAgentClient({ goldens: g }),
    start: async () => {
      throw error;
    },
  });

  it("a denied or missing binary becomes an error state with a fix action, not a hang", async () => {
    configureAgentRuntimeForTests(failing({ kind: "binary-not-found", message: "no claude" }));
    get().openPane();
    await get().sendMessage("hi");
    expect(chat().state).toBe("error");
    expect(chat().error?.kind).toBe("binary-not-found");
    expect(chat().turns[0]!.status).toBe("error");
    // retry is only meaningful once the user fixed it; composer is disabled meanwhile
    await get().sendMessage("again");
    expect(chat().turns).toHaveLength(1);
  });

  it("classifies errors", () => {
    expect(classifyStartError("Spawn denied by the user").kind).toBe("spawn-denied");
    expect(classifyStartError(new Error("Command agent_start not found")).message).toMatch(
      /not available/,
    );
    expect(classifyStartError({ message: "boom" }).kind).toBe("spawn-failed");
  });

  it("retry resends the last user message after a retryable failure", async () => {
    let calls = 0;
    const base = createMockAgentClient({ goldens: g });
    configureAgentRuntimeForTests({
      ...base,
      start: async (a: Parameters<AgentClient["start"]>[0]) => {
        if (calls++ === 0) throw new Error("transient");
        return base.start(a);
      },
    });
    get().openPane();
    const id = get().activeChatId!;
    await get().sendMessage("try me");
    expect(chat().error?.kind).toBe("spawn-failed");
    await get().retry();
    await base.idle(id);
    await settle();
    expect(chat().turns).toHaveLength(2);
    expect(chat().turns[1]!.user?.text).toBe("try me");
    expect(chat().turns[1]!.status).toBe("completed");
  });
});

describe("paths", () => {
  it("makes vault-relative paths", () => {
    expect(toVaultRelative("/v/Notes/a.md", "/v")).toBe("Notes/a.md");
    expect(toVaultRelative("/other/a.md", "/v")).toBeNull();
    expect(toVaultRelative("/v2/a.md", "/v")).toBeNull();
    expect(toVaultRelative("/v/a.md", null)).toBeNull();
  });
});
