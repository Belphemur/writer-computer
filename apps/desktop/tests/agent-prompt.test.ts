import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vite-plus/test";
import { buildPrompt, relativeToCwd, type PromptInput } from "../src/lib/agent/context-text";
import {
  mentionToken,
  mentionsActiveNote,
  middleTruncate,
  pickLabel,
  unattachedMentions,
} from "../src/lib/agent/mentions";
import { matchPath, prepare, prepareQuery } from "../src/lib/search-rank";
import { createRefIo, prepareRefs, type RefIo } from "../src/lib/agent/ref-resolve";
import { applyTrigger, findTrigger, tokenizeMessage } from "../src/lib/agent/trigger";

vi.mock("../src/lib/tauri", () => ({ fileExists: vi.fn(), findFilesByExactName: vi.fn() }));

const cand = (path: string, label: string) => ({ kind: "note", path, label, detail: "" }) as const;

const GOLDEN = new URL("../shared/agent-prompt-golden.json", import.meta.url);
type Case = PromptInput & { name: string; prompt: string };
const cases = JSON.parse(readFileSync(GOLDEN, "utf8")) as Case[];

describe("prompt golden (shared with the Rust encoder test)", () => {
  if (process.env.WRITER_UPDATE_GOLDEN) {
    it("rewrites the golden", () => {
      const next = cases.map((c) => ({ ...c, prompt: buildPrompt(c) }));
      writeFileSync(GOLDEN, `${JSON.stringify(next, null, 2)}\n`);
    });
    return;
  }
  for (const c of cases)
    it(c.name, () => {
      expect(c.prompt).not.toBe("");
      expect(buildPrompt(c)).toBe(c.prompt);
    });
});

const note = (path: string) => ({ kind: "note", path }) as const;
const active = (path: string) => ({ kind: "active-note", path, inline: false }) as const;

describe("buildPrompt", () => {
  it("sends exactly what claude should see for the reference example", () => {
    expect(
      buildPrompt({
        text: "compare @Projects/Plan.md with @activenote and /summarize",
        refs: [active("Notes/Today.md"), note("Projects/Plan.md")],
        cwd: null,
        skills: ["summarize"],
      }),
    ).toBe(
      [
        "compare @Projects/Plan.md with @Notes/Today.md and /summarize",
        "",
        "<references>",
        "Attached by the user, paths relative to the working directory (read them with the Read tool when relevant):",
        "- @Notes/Today.md (active note: the note open in Writer)",
        "- @Projects/Plan.md (note)",
        "- /summarize (skill, not expanded mid-message: invoke it with the Skill tool)",
        "</references>",
      ].join("\n"),
    );
  });

  it("keeps @activenote literal, with no entry, when no note is open", () => {
    expect(buildPrompt({ text: "fix @activenote", refs: [], cwd: null })).toBe("fix @activenote");
  });

  it("lists a path once however many times it is attached or typed", () => {
    const out = buildPrompt({
      text: "@a.md and @a.md and @activenote",
      refs: [active("a.md"), note("a.md"), note("a.md")],
      cwd: null,
    });
    expect(out.split("\n").filter((l) => l.startsWith("- "))).toEqual([
      "- @a.md (active note: the note open in Writer)",
    ]);
    expect(out.startsWith("@a.md and @a.md and @a.md\n")).toBe(true);
  });

  it("resolves the active note at send time, so a rename between compose and send follows", () => {
    const text = "summarize @activenote";
    const composed = buildPrompt({ text, refs: [active("Old.md")], cwd: null });
    const sent = buildPrompt({ text, refs: [active("Renamed.md")], cwd: null });
    expect(composed.startsWith("summarize @Old.md")).toBe(true);
    expect(sent.startsWith("summarize @Renamed.md")).toBe(true);
    expect(sent).not.toContain("Old.md");
  });

  it("makes paths relative to the project folder and never absolute", () => {
    expect(relativeToCwd("Projects/A/x.md", "Projects/A")).toBe("x.md");
    expect(relativeToCwd("Notes/y.md", "Projects/A")).toBe("../../Notes/y.md");
    expect(relativeToCwd("Projects/B/z.md", "Projects/A")).toBe("../B/z.md");
    expect(relativeToCwd("Projects/A", "Projects/A")).toBe(".");
    expect(relativeToCwd("Notes/y.md", null)).toBe("Notes/y.md");
    expect(mentionToken(relativeToCwd("Notes/My Note.md", "Projects/A"))).toBe(
      '@"../../Notes/My Note.md"',
    );
  });

  it("adds no footer behind a leading slash command and none for an unknown mid-message skill", () => {
    expect(buildPrompt({ text: "/summarize @n.md", refs: [note("n.md")], cwd: null })).toBe(
      "/summarize @n.md",
    );
    expect(buildPrompt({ text: "try /nope", refs: [], cwd: null, skills: ["x"] })).toBe(
      "try /nope",
    );
  });
});

describe("tokenizeMessage", () => {
  const kinds = (t: string) =>
    tokenizeMessage(t)
      .filter((s) => s.kind !== "text")
      .map((s) => s.raw);

  it("finds mentions, quoted mentions and skills, and round-trips the text", () => {
    const text = 'compare @Projects/Plan.md, @"My Plan.md" and (@activenote) then /summarize.';
    expect(kinds(text)).toEqual([
      "@Projects/Plan.md",
      '@"My Plan.md"',
      "@activenote",
      "/summarize",
    ]);
    expect(
      tokenizeMessage(text)
        .map((s) => (s.kind === "text" ? s.text : s.raw))
        .join(""),
    ).toBe(text);
  });

  it("agrees with the composer trigger rules", () => {
    expect(kinds("src/lib/foo a@b.c and/or /usr/bin https://x.test/@y")).toEqual([]);
    expect(tokenizeMessage("/go now")[0]).toMatchObject({ kind: "slash", atStart: true });
    expect(tokenizeMessage("do /go")[1]).toMatchObject({ kind: "slash", atStart: false });
    expect(mentionsActiveNote("hi @ActiveNote.")).toBe(true);
    expect(mentionsActiveNote("hi @activenote-x")).toBe(false);
  });
});

describe("readable names in the text, full paths to claude", () => {
  const PATH =
    "Management/Meeting Preps/2026/11/2026-11-16 - Daniel Wierdsma Staff Timing and Growth Plan.md";
  const NAME = "Daniel Wierdsma Staff Timing and Growth Plan";

  it("sends the user's example as the quoted full path, in the text and the footer", () => {
    const out = buildPrompt({
      text: `prep @"${NAME}"`,
      refs: [{ kind: "note", path: PATH, label: NAME }],
      cwd: null,
    });
    expect(out.startsWith(`prep @"${PATH}"\n\n<references>`)).toBe(true);
    expect(out).toContain(`- @"${PATH}" (note)`);
    expect(out).not.toContain(`@"${NAME}"`);
  });

  it("maps same-named notes in two folders to their own refs by the pick's label", () => {
    const refs = [
      { kind: "note", path: "A/Plan.md", label: "Plan" },
      {
        kind: "note",
        path: "B/Plan.md",
        label: pickLabel(cand("B/Plan.md", "Plan"), [
          { kind: "note", path: "A/Plan.md", label: "Plan" },
        ]),
      },
    ] as const;
    expect(refs[1].label).toBe("B/Plan");
    const out = buildPrompt({ text: "@Plan vs @B/Plan", refs, cwd: null });
    expect(out.startsWith("@A/Plan.md vs @B/Plan.md\n")).toBe(true);
  });

  it("keeps a damaged token literal but still lists the attached ref", () => {
    const out = buildPrompt({
      text: 'see @"Daniel Wierdsm',
      refs: [{ kind: "note", path: "T/Daniel Wierdsma.md", label: "Daniel Wierdsma" }],
      cwd: null,
    });
    expect(out.startsWith('see @"Daniel Wierdsm\n')).toBe(true);
    expect(out).toContain('- @"T/Daniel Wierdsma.md" (note)');
  });

  it("pickLabel adds parent folders until the token is unique (one function, one rule)", () => {
    expect(pickLabel(cand("A/x.md", "Plan"), [])).toBe("Plan");
    const first = { kind: "note", path: "Mgmt/2026/10/Plan.md", label: "Plan" } as const;
    expect(pickLabel(cand("Mgmt/2026/11/Plan.md", "Plan"), [first])).toBe("11/Plan");
    const second = { kind: "note", path: "Mgmt/2026/11/Plan.md", label: "11/Plan" } as const;
    expect(pickLabel(cand("Other/2026/11/Plan.md", "Plan"), [first, second])).toBe("2026/11/Plan");
    expect(pickLabel(cand("A/x.md", 'a "b"'), [])).toBe("A/x");
    // the same note picked twice is not a clash
    expect(pickLabel(cand("Mgmt/2026/10/Plan.md", "Plan"), [first])).toBe("Plan");
  });
});

describe("prepareRefs", () => {
  const io = (files: string[], dirs: string[] = []): RefIo => ({
    exists: async (p) => files.includes(p) || dirs.includes(p),
    findByName: async (name) => files.filter((f) => f.slice(f.lastIndexOf("/") + 1) === name),
  });

  it("follows a rename between the pick and the send when the file name is unique", async () => {
    const out = await prepareRefs(
      "see @Plan",
      [{ kind: "note", path: "Old/Plan.md", label: "Plan" }],
      io(["New/Plan.md"]),
    );
    expect(out).toEqual([{ kind: "note", path: "New/Plan.md", label: "Plan" }]);
  });

  it("keeps the recorded path when the file name is not unique or not found", async () => {
    const refs = [{ kind: "note", path: "Old/Plan.md" }] as const;
    expect(await prepareRefs("", refs, io(["A/Plan.md", "B/Plan.md"]))).toEqual(refs);
    expect(await prepareRefs("", refs, io([]))).toEqual(refs);
  });

  it("leaves a hand-typed bare name literal: no reference, nothing resolved by name", async () => {
    const files = ["Notes/Solo.md", "A/Twin.md", "B/Twin.md"];
    expect(await prepareRefs("@Solo @Twin @Missing @activenote", [], io(files))).toEqual([]);
    expect(buildPrompt({ text: "read @Solo", refs: [], cwd: null })).toBe("read @Solo");
  });

  it("resolves a hand-typed exact vault path to an existing note or folder only", async () => {
    const files = ["Notes/Solo.md"];
    const out = await prepareRefs(
      "@Notes/Solo.md @Notes/Gone.md @Docs/ @../x.md @/etc/hosts",
      [],
      io(files, ["Docs"]),
    );
    expect(out).toEqual([
      { kind: "note", path: "Notes/Solo.md" },
      { kind: "folder", path: "Docs" },
    ]);
    expect(buildPrompt({ text: "@Docs/ x", refs: out, cwd: "Projects/A" })).toContain(
      "@../../Docs x",
    );
  });

  it("does not look up by name while the recorded path still exists", async () => {
    const findByName = vi.fn(async () => ["Elsewhere/Plan.md"]);
    const refs = [{ kind: "note", path: "Old/Plan.md" }] as const;
    const out = await prepareRefs("", refs, { exists: async () => true, findByName });
    expect(out).toEqual(refs);
    expect(findByName).not.toHaveBeenCalled();
  });

  it("createRefIo follows a moved note through the Rust command's vault-relative result", async () => {
    const tauri = await import("../src/lib/tauri");
    vi.mocked(tauri.fileExists).mockResolvedValue(false);
    vi.mocked(tauri.findFilesByExactName).mockResolvedValue(["New/Plan.md"]);
    const refs = [{ kind: "note", path: "Old/Plan.md" }] as const;
    const out = await prepareRefs("", refs, createRefIo("/vault"));
    expect(tauri.fileExists).toHaveBeenCalledWith("/vault/Old/Plan.md");
    expect(tauri.findFilesByExactName).toHaveBeenCalledWith("Plan.md");
    expect(out).toEqual([{ kind: "note", path: "New/Plan.md" }]);
    vi.mocked(tauri.findFilesByExactName).mockResolvedValue([]);
    expect(await prepareRefs("", refs, createRefIo("/vault"))).toEqual(refs);
    vi.mocked(tauri.findFilesByExactName).mockResolvedValue(["A/Plan.md", "B/Plan.md"]);
    expect(await prepareRefs("", refs, createRefIo("/vault"))).toEqual(refs);
  });

  it("does not re-resolve a token a pick already owns", async () => {
    const refs = [{ kind: "note", path: "A/Twin.md", label: "Twin" }] as const;
    expect(await prepareRefs("@Twin", refs, io(["A/Twin.md", "B/Twin.md"]))).toEqual(refs);
  });
});

describe("unattachedMentions", () => {
  const attached = [{ kind: "note", path: "A/Plan.md", label: "Plan" }] as const;
  it("names tokens no chip owns, not picked names, @activenote or typed paths", () => {
    expect(unattachedMentions("see @Plan and @Other and @activenote", attached)).toEqual([
      "@Other",
    ]);
    expect(unattachedMentions("see @Plan", [])).toEqual(["@Plan"]);
    expect(unattachedMentions("see @A/Plan.md @notes.md", [])).toEqual([]);
    expect(unattachedMentions('see @"Two Words"', [])).toEqual(['@"Two Words"']);
  });
  it("truncates long paths in the middle and keeps the ends", () => {
    const p = "Management/Meeting Preps/2026/11/2026-11-16 - Daniel Wierdsma Staff Timing.md";
    const t = middleTruncate(p, 40);
    expect(t.length).toBe(40);
    expect(t.startsWith("Management/")).toBe(true);
    expect(t.endsWith("Timing.md")).toBe(true);
    expect(middleTruncate("short.md")).toBe("short.md");
  });
});

describe("findTrigger around a multi-word quoted name", () => {
  const text = 'compare @"Daniel Wierdsma Plan" with /sum';
  it("opens the menu with the words typed so far, anywhere inside the token", () => {
    expect(findTrigger('x @"Daniel Wi', 'x @"Daniel Wi'.length)).toMatchObject({
      char: "@",
      start: 2,
      query: "Daniel Wi",
    });
    const t = findTrigger(text, text.indexOf("Wierdsma") + 3)!;
    expect(t).toMatchObject({ char: "@", start: 8, query: "Daniel Wie" });
    expect(text.slice(t.start, t.end)).toBe('@"Daniel Wierdsma Plan"');
  });

  it("survives Backspace: deleting a character or the closing quote still works", () => {
    const shortened = 'compare @"Daniel Wierdsma Pla" with';
    expect(findTrigger(shortened, shortened.indexOf('" with'))).toMatchObject({
      query: "Daniel Wierdsma Pla",
    });
    const open = 'compare @"Daniel Wierdsma Plan with';
    const t = findTrigger(open, open.indexOf(" with"))!;
    expect(t.query).toBe("Daniel Wierdsma Plan");
    expect(applyTrigger(open, t, '@"Other"').text).toBe('compare @"Other" with');
  });

  it("a pick replaces the whole quoted span and keeps the surrounding text", () => {
    const t = findTrigger(text, text.indexOf("Plan"))!;
    expect(applyTrigger(text, t, '@"New Name"').text).toBe('compare @"New Name" with /sum');
  });
});

describe("path text finds a note (the ranker behind the @ menu)", () => {
  it("matches words of the folder path in any order, together with the file name", () => {
    const path = "Management/Meeting Preps/2026/11/2026-11-16 - Daniel Wierdsma Staff Timing.md";
    const m = (q: string) => matchPath(prepareQuery(q), prepare(path));
    expect(m("Meeting Preps 2026")).not.toBeNull();
    expect(m("Management daniel")).not.toBeNull();
    expect(m("Preps/2026")).not.toBeNull();
    expect(m("nonexistentfolder daniel")).toBeNull();
  });
});
