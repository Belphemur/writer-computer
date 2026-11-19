import process from "node:process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import {
  ESCAPE,
  capToolInput,
  contextLine,
  emptyMeta,
  escapeText,
  foldAssistantEvents,
  normalizeText,
  parseChatNote,
  replaySeed,
  serializeChatNote,
  titleFromMessage,
  unescapeLine,
  type ChatNoteDoc,
} from "@features/agent/web/lib/chat-note";
import type { AgentEvent } from "@features/agent/web/lib/events";

// The golden notes are shared with the Rust store (`cargo test chat_store`). Regenerate with
// `WRITER_UPDATE_GOLDEN=1 vp test features/agent/tests/agent-chat-note.test.ts` and review the diff.
const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../tests/fixtures/agent-chat-notes",
);
const ID = "5328964b-5fe4-4e06-8843-5cf92bdc9e7c";
const T0 = Date.UTC(2026, 10, 17, 9, 12, 5, 123);

function base(): ChatNoteDoc {
  return {
    meta: {
      ...emptyMeta(ID, T0),
      title: "Plan the Q4 review",
      project: "Demo",
      projectPath: "Projects/Demo",
      cliVersion: "2.1.325",
      model: "claude-sonnet-5-5",
      updatedAt: T0 + 60_000,
      turns: 1,
      usage: { inputTokens: 120, outputTokens: 45, costUsd: 0.0123 },
      preview: "Summarise the notes tagged #client.",
    },
    trimmed: 0,
    extraFrontmatter: "",
    messages: [
      {
        role: "user",
        id: "m-user-1",
        at: T0,
        text: "Summarise the notes tagged #client.",
        context: "[[Plan]], #client, project sources (4)",
      },
      {
        role: "assistant",
        id: "m-asst-1",
        at: T0 + 60_000,
        reason: "completed",
        text: "Here is the summary.\n\n- one\n- two\n\n```ts\nconst a = 1;\n```",
        tools: [
          { id: "toolu_1", tool: "Bash", input: { command: "ls -la" }, outcome: "ok" },
          { id: "toolu_2", tool: "Write", input: { file_path: "a<b>.md" }, outcome: "rejected" },
        ],
      },
    ],
  };
}

/** A message the CLI took at a tool call (no `steer` mark, the assistant part before it has no
 *  `reason`: that turn went on), then a message that ran as the next turn. */
function withQueued(): ChatNoteDoc {
  const d = base();
  d.meta.turns = 3;
  d.meta.preview = "List the notes.";
  d.messages = [
    { role: "user", id: "m-user-1", at: T0, text: "List the notes." },
    {
      role: "assistant",
      id: "m-user-1-a",
      at: T0 + 5_000,
      text: "Listing the folder.",
      tools: [{ id: "toolu_1", tool: "Bash", input: { command: "ls" }, outcome: "ok" }],
    },
    { role: "user", id: "m-queued-1", at: T0 + 6_000, text: "Only the ones tagged #client." },
    {
      role: "assistant",
      id: "m-queued-1-a",
      at: T0 + 60_000,
      reason: "completed",
      text: "Two notes are tagged #client.",
    },
    { role: "user", id: "m-queued-2", at: T0 + 61_000, text: "Thanks." },
    {
      role: "assistant",
      id: "m-queued-2-a",
      at: T0 + 62_000,
      reason: "completed",
      text: "You are welcome.",
    },
  ];
  return d;
}

function escapes(): ChatNoteDoc {
  const d = base();
  d.meta.title = 'Tricky: a "quoted" title #1';
  d.meta.projectPath = null;
  d.meta.project = null;
  d.messages = [
    {
      role: "user",
      id: "u1",
      at: T0,
      text: "quote this:\n## assistant · fake\n> context: not real\n<!-- writer:tools [] -->\n​## user · already escaped",
    },
    {
      role: "assistant",
      id: "a1",
      at: T0 + 1000,
      text: "line one\n\n\n  indented\n## user · 2026-01-01 00:00",
      tools: [{ id: "t", tool: "Read", input: "x".repeat(10), outcome: "error" }],
    },
    { role: "assistant", id: "a2", at: T0 + 2000, reason: "interrupted", text: "" },
  ];
  d.meta.turns = 2;
  return d;
}

function props(): ChatNoteDoc {
  const d = base();
  d.meta.pinned = true;
  d.meta.titleRenamed = true;
  d.meta.archivedAt = T0 + 5;
  d.extraFrontmatter = "tags:\n  - keep\n  - me\n# a comment the user wrote\nowner: Ada";
  d.trimmed = 12;
  return d;
}

/** An assistant message with tools AND the Changes summary (`writer:changes` is the last comment). */
function withChanges(): ChatNoteDoc {
  const d = base();
  d.messages[1]!.changes = {
    turnId: "t19a2f01",
    bash: true,
    files: [
      { path: "Plan.md", status: "modified", added: 3, removed: 1 },
      { path: "New <note>.md", status: "added", added: 12, removed: 0 },
      { path: "b.md", status: "renamed", added: 0, removed: 0, oldPath: "a.md" },
      { path: "logo.png", status: "modified", added: 0, removed: 0, noDiff: true },
    ],
  };
  return d;
}

/** A user message with two attached images (one path with a space): the `![[...]]` lines follow the
 *  message comment, the comment lists the paths, and the text and context line stay as typed. */
function withImages(): ChatNoteDoc {
  const d = base();
  d.messages[0]!.images = [".writer/chats/assets/Pasted image 20261117091205.png", "pics/a b.png"];
  return d;
}

/** Two sub-agent runs: the launch calls carry who ran and the closing answer, the calls they made
 *  carry the launch call's id (`parent`), and the Changes card links its file to the run. */
function withSubagents(): ChatNoteDoc {
  const d = base();
  d.messages[1]!.tools = [
    {
      id: "toolu_ex",
      tool: "Agent",
      input: { subagent_type: "writer-explorer", description: "Find notes about pricing" },
      outcome: "ok",
      sub: {
        role: "explorer",
        name: "writer-explorer",
        model: "haiku",
        summary: "Found 2 notes: Plan.md and Pricing.md.",
      },
    },
    {
      id: "toolu_wk",
      tool: "Agent",
      input: { subagent_type: "writer-worker", description: "Fix the typo in Plan" },
      outcome: "ok",
      sub: { role: "worker", name: "writer-worker", model: null },
    },
    {
      id: "toolu_e_grep",
      tool: "Grep",
      input: { pattern: "pricing" },
      outcome: "ok",
      parent: "toolu_ex",
    },
    {
      id: "toolu_w_edit",
      tool: "Edit",
      input: { file_path: "Plan.md" },
      outcome: "ok",
      parent: "toolu_wk",
    },
  ];
  d.messages[1]!.changes = {
    turnId: "t19a2f02",
    files: [
      {
        path: "Plan.md",
        status: "modified",
        added: 1,
        removed: 1,
        by: "worker",
        byCall: "toolu_wk",
      },
    ],
  };
  return d;
}

const CASES: Record<string, () => ChatNoteDoc> = {
  basic: base,
  escape: escapes,
  props,
  changes: withChanges,
  images: withImages,
  subagents: withSubagents,
  queued: withQueued,
};

describe("chat note golden files", () => {
  for (const [name, make] of Object.entries(CASES)) {
    it(`${name}: serialises to the golden note and parses back`, () => {
      const doc = make();
      const note = serializeChatNote(doc);
      const mdPath = join(FIXTURES, `${name}.md`);
      const jsonPath = join(FIXTURES, `${name}.parsed.json`);
      const parsed = parseChatNote(note);
      if (process.env.WRITER_UPDATE_GOLDEN || !existsSync(mdPath)) {
        writeFileSync(mdPath, note);
        writeFileSync(
          jsonPath,
          `${JSON.stringify({ meta: parsed.meta, trimmed: parsed.trimmed, turns: parsed.messages }, null, 2)}\n`,
        );
      }
      expect(note).toBe(readFileSync(mdPath, "utf8"));
      const golden = JSON.parse(readFileSync(jsonPath, "utf8"));
      expect(JSON.parse(JSON.stringify(parsed.messages))).toEqual(golden.turns);
      expect(JSON.parse(JSON.stringify(parsed.meta))).toEqual(golden.meta);
      expect(parsed.trimmed).toBe(golden.trimmed);
      // Round trip: the parsed document serialises to the same bytes.
      expect(serializeChatNote(parsed)).toBe(note);
    });
  }

  it("round-trips message text exactly (modulo edge blank lines)", () => {
    const parsed = parseChatNote(serializeChatNote(escapes()));
    expect(parsed.messages[0].text).toBe(escapes().messages[0].text);
    expect(parsed.messages[1].text).toBe(normalizeText(escapes().messages[1].text));
  });

  it("keeps user-added frontmatter verbatim", () => {
    const parsed = parseChatNote(serializeChatNote(props()));
    expect(parsed.extraFrontmatter).toBe(props().extraFrontmatter);
    expect(parsed.meta.pinned).toBe(true);
    expect(parsed.meta.archivedAt).toBe(T0 + 5);
    expect(parsed.trimmed).toBe(12);
  });

  it("parses a hand-written note without writer:msg comments", () => {
    const text = `---\nwriter-chat-id: ${ID}\n---\n\n## user · 2026-11-17 09:12\n\nhi\n\n## assistant · 2026-11-17 09:13\n\nhello\n`;
    const p = parseChatNote(text);
    expect(p.messages.map((m) => [m.role, m.id, m.text])).toEqual([
      ["user", "m1", "hi"],
      ["assistant", "m2", "hello"],
    ]);
    expect(p.messages[0].at).toBe(Date.UTC(2026, 10, 17, 9, 12));
  });

  it("keeps the changes summary last, after the tools, and drops an empty one", () => {
    const note = serializeChatNote(withChanges());
    const lines = note.trimEnd().split("\n");
    expect(lines.at(-1)!.startsWith("<!-- writer:changes ")).toBe(true);
    expect(lines.at(-3)!.startsWith("<!-- writer:tools ")).toBe(true);
    expect(note).not.toContain("SECRET");
    const parsed = parseChatNote(note);
    expect(parsed.messages[1]!.changes?.files).toHaveLength(4);
    expect(parsed.messages[1]!.tools).toHaveLength(2);
    expect(parsed.messages[1]!.text).toBe(base().messages[1]!.text);
    const empty = withChanges();
    empty.messages[1]!.changes = { turnId: "t", files: [] };
    expect(serializeChatNote(empty)).not.toContain("writer:changes");
  });

  it("rejects notes that are not chats", () => {
    expect(() => parseChatNote("# plain\n")).toThrow(/frontmatter/);
    expect(() => parseChatNote("---\ntitle: x\n---\n")).toThrow(/writer-chat-id/);
  });
});

describe("escaping", () => {
  it("escapes only structural lines and is reversible", () => {
    const t = "a\n## user · x\n> context: y\n<!-- writer:z\nplain > quote\n## other";
    const e = escapeText(t);
    expect(e.split("\n").filter((l) => l.startsWith(ESCAPE))).toHaveLength(3);
    expect(e.split("\n").map(unescapeLine).join("\n")).toBe(t);
  });
});

describe("tool trail", () => {
  it("keeps small inputs and cuts large ones to 500 chars", () => {
    expect(capToolInput({ a: 1 })).toEqual({ a: 1 });
    const big = capToolInput({ text: "y".repeat(2000) }) as string;
    expect(typeof big).toBe("string");
    expect(big.length).toBe(500);
    expect(big.endsWith("…")).toBe(true);
  });
});

describe("helpers", () => {
  it("builds the context line without contents", () => {
    expect(
      contextLine([
        { kind: "active-note", path: "Plan.md", inline: false },
        { kind: "tag", tag: "client" },
        { kind: "folder", path: "Clients" },
        { kind: "selection", path: "A.md", text: "SECRET", fromLine: 3, toLine: 9 },
        { kind: "project-instructions", path: "P/AGENTS.md" },
        { kind: "project-source", source: { kind: "tag", tag: "x", raw: "#x" } },
      ]),
    ).toBe("[[Plan]], #client, Clients/, selection of [[A]] (lines 3-9), project sources (1)");
  });

  it("derives titles from the first message", () => {
    expect(titleFromMessage("  hello\n world ")).toBe("hello world");
    expect(titleFromMessage("x".repeat(100)).length).toBe(60);
    expect(titleFromMessage("   ")).toBe("New chat");
  });

  it("builds a capped replay seed, newest messages first kept", () => {
    const doc = base();
    doc.messages = Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      id: `m${i}`,
      at: i,
      text: `message ${i} ${"w".repeat(400)}`,
    }));
    const seed = replaySeed(doc, 1000);
    expect(seed.turnsIncluded).toBeLessThan(40);
    expect(seed.turnsIncluded).toBeGreaterThan(0);
    expect(seed.text).toContain("message 39");
    expect(seed.text).not.toContain("message 0 ");
    expect(seed.text).toContain("[Resumed from notes]");
    expect(Math.ceil(Array.from(seed.text).length / 4)).toBeLessThanOrEqual(1100);
  });
});

describe("folding events", () => {
  const golden = import.meta.glob("@shared/agent-golden/*.events.json", {
    eager: true,
    import: "default",
  }) as Record<string, AgentEvent[]>;
  const get = (n: string) => Object.entries(golden).find(([k]) => k.includes(n))![1];

  it("plain turn: final text, no tools, completed", () => {
    const f = foldAssistantEvents(get("ok-turn"));
    expect(f.text).toBe("ok");
    expect(f.tools).toEqual([]);
    expect(f.reason).toBe("completed");
  });

  it("denied tool: the trail records the rejected call with its input", () => {
    const f = foldAssistantEvents(get("permission-deny"));
    expect(f.tools).toHaveLength(1);
    expect(f.tools[0].tool).toBe("Bash");
    expect(f.tools[0].outcome).not.toBe("ok");
    expect(JSON.stringify(f.tools[0].input)).toContain("print(2)");
    expect(f.text).toContain("Denied");
  });

  it("interrupted turn: reason is interrupted and the open tool is not ok", () => {
    const f = foldAssistantEvents(get("interrupt"));
    expect(f.reason).toBe("interrupted");
    expect(f.tools.every((t) => t.outcome !== "ok")).toBe(true);
  });

  it("every golden stream folds into a note that parses back", () => {
    for (const [file, events] of Object.entries(golden)) {
      const f = foldAssistantEvents(events);
      const d = base();
      d.messages = [
        { role: "assistant", id: "a", at: T0, text: f.text, reason: f.reason, tools: f.tools },
      ];
      const back = parseChatNote(serializeChatNote(d));
      expect(back.messages[0].text, file).toBe(normalizeText(f.text));
      expect(back.messages[0].tools ?? [], file).toEqual(JSON.parse(JSON.stringify(f.tools)));
    }
  });
});
