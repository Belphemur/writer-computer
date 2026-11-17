import { describe, expect, it } from "vite-plus/test";
import {
  chatNoteAbsPath,
  cleanupCandidates,
  filterChats,
  groupByProject,
  projectsOf,
  sortChats,
} from "../src/lib/agent/chat-history";
import type { ChatSummary } from "../src/lib/agent/events";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 17);

const chat = (id: string, over: Partial<ChatSummary> = {}): ChatSummary => ({
  chatId: id,
  path: `${id}.md`,
  title: id,
  projectPath: null,
  sessionId: id,
  createdAt: 1,
  updatedAt: 1,
  turnCount: 1,
  archived: false,
  pinned: false,
  ...over,
});

const SAMPLE = [
  chat("a", {
    title: "Quarterly review",
    updatedAt: NOW - DAY,
    createdAt: NOW - 10 * DAY,
    projectPath: "Projects/Demo",
  }),
  chat("b", {
    title: "Groceries",
    preview: "buy oat milk",
    updatedAt: NOW - 2 * DAY,
    createdAt: NOW - 5 * DAY,
  }),
  chat("c", { title: "Old", updatedAt: NOW - 100 * DAY, projectPath: "Projects/Demo" }),
  chat("d", { title: "Pinned old", updatedAt: NOW - 200 * DAY, pinned: true }),
];

describe("history view logic", () => {
  it("searches title and first message, all words, case-insensitively", () => {
    expect(filterChats(SAMPLE, "QUARTERLY").map((c) => c.chatId)).toEqual(["a"]);
    expect(filterChats(SAMPLE, "oat milk").map((c) => c.chatId)).toEqual(["b"]);
    expect(filterChats(SAMPLE, "oat nothing")).toEqual([]);
    expect(filterChats(SAMPLE, "  ")).toHaveLength(4);
  });

  it("sorts pinned first, then by the chosen date", () => {
    expect(sortChats(SAMPLE, "updated").map((c) => c.chatId)).toEqual(["d", "a", "b", "c"]);
    expect(sortChats(SAMPLE.slice(0, 2), "created").map((c) => c.chatId)).toEqual(["b", "a"]);
  });

  it("groups by project in order of the newest chat, vault chats as one group", () => {
    const groups = groupByProject(SAMPLE, "updated");
    expect(groups.map((g) => [g.label, g.chats.map((c) => c.chatId)])).toEqual([
      ["No project", ["d", "b"]],
      ["Demo", ["a", "c"]],
    ]);
    expect(projectsOf(SAMPLE)).toEqual(["Projects/Demo", null]);
  });

  it("offers only stale, unpinned chats for clean-up and nothing when keep-days is 0", () => {
    expect(cleanupCandidates(SAMPLE, 90, NOW).map((c) => c.chatId)).toEqual(["c"]);
    expect(cleanupCandidates(SAMPLE, 0, NOW)).toEqual([]);
    expect(cleanupCandidates(SAMPLE, -5, NOW)).toEqual([]);
  });

  it("builds the absolute note path", () => {
    expect(chatNoteAbsPath("/v/", { path: "P/.chats/x.md" })).toBe("/v/P/.chats/x.md");
  });
});
