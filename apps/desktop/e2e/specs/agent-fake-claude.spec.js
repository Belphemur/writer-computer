// End-to-end: the native agent pane against a FAKE `claude` that replays the captured stream-json
// sessions (fixtures/agent-fake-claude). Run with `sh fixtures/agent-fake-claude/run.sh`; without
// that script's environment this spec skips itself. Covers: send and streamed reply, the chat
// note written to the hidden folder, permission allow and deny, stop, a crash, and reopening a
// chat after an app restart from History. The real CLI is a manual check (spec section 12).
import { ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const VAULT = process.env.WRITER_E2E_AGENT_VAULT;
const FAKE_LOG = process.env.WRITER_E2E_FAKE_CLAUDE_LOG;
const SHOTS = process.env.WRITER_E2E_SHOTS || join(HERE, "../.cache/shots");
const CHATS = () => join(VAULT, ".writer/chats");

const shot = async (name) => {
  try {
    mkdirSync(SHOTS, { recursive: true });
    await browser.saveScreenshot(join(SHOTS, `agent-${name}.png`));
  } catch {
    /* screenshots are best effort */
  }
};

async function pressCmd(key) {
  await browser.execute((k) => {
    const ev = () =>
      new KeyboardEvent("keydown", { key: k, metaKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(ev());
    document.dispatchEvent(ev());
  }, key);
}

async function runCommand(id) {
  await pressCmd("p");
  await $("[cmdk-item]").waitForExist({ timeout: 8_000 });
  const item = await $(`[cmdk-item][data-value="${id}"]`);
  await item.waitForExist({ timeout: 5_000 });
  await item.click();
}

async function openPane() {
  if (!(await $("[data-agent-pane]").isExisting())) await runCommand("agent-toggle-pane");
  await $("[data-agent-pane]").waitForExist({ timeout: 8_000 });
}

/** Type into the composer and press Enter. */
async function send(text) {
  const box = await $('textarea[aria-label="Message the agent"]');
  await box.waitForExist({ timeout: 8_000 });
  await box.click();
  await box.setValue(text);
  await browser.keys("Enter");
}

const transcript = async () => (await $("[data-agent-transcript]")).getText();

async function waitTranscript(pattern, timeout = 20_000) {
  await browser.waitUntil(async () => pattern.test(await transcript()), {
    timeout,
    timeoutMsg: `transcript never matched ${pattern}`,
  });
}

function chatNotes() {
  if (!existsSync(CHATS())) return [];
  return readdirSync(CHATS()).filter((f) => f.endsWith(".md"));
}

async function clickButton(label) {
  const btn = await $(`button=${label}`);
  await btn.waitForExist({ timeout: 10_000 });
  await btn.click();
}

describe("Native agent pane + fake claude", function () {
  this.timeout(120_000);

  before(async function () {
    if (!VAULT || !FAKE_LOG) {
      console.log("SKIP: set up via `sh fixtures/agent-fake-claude/run.sh`");
      this.skip();
    }
    await $('button[aria-label="Hide sidebar"]').waitForExist({ timeout: 30_000 });
  });

  it("A: sends a message and streams the reply", async function () {
    await openPane();
    await send("hello from the e2e [fake:plain]");
    await waitTranscript(/FAKE-CLAUDE-REPLY: hello from the e2e/);
    await shot("A-reply");
    const spawns = readFileSync(FAKE_LOG, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((l) => l.ev === "spawn");
    ok(spawns.length >= 1, "the fake claude was spawned");
    ok(spawns[0].argv.includes("stream-json"), "stream-json protocol");
    ok(spawns[0].argv.includes("--session-id"), "first spawn uses --session-id");
    ok(!spawns[0].argv.some((a) => a.includes("dangerously")), "no bypass flag");
  });

  it("B: the chat is saved as a hidden markdown note", async function () {
    await browser.waitUntil(async () => chatNotes().length === 1, {
      timeout: 15_000,
      timeoutMsg: "no chat note in .writer/chats",
    });
    const text = readFileSync(join(CHATS(), chatNotes()[0]), "utf8");
    ok(text.startsWith("---\nwriter-chat-id:"), "frontmatter first");
    ok(text.includes("hello from the e2e"), "the user message is in the note");
    await browser.waitUntil(
      async () => readFileSync(join(CHATS(), chatNotes()[0]), "utf8").includes("FAKE-CLAUDE-REPLY"),
      { timeout: 15_000, timeoutMsg: "the reply never reached the note" },
    );
    // Hidden folder: the vault index never lists it.
    const files = await browser.executeAsync((done) => {
      window.__TAURI_INTERNALS__
        .invoke("fuzzy_search", { query: "writer-chat", limit: 20 })
        .then((r) => done(JSON.stringify(r)))
        .catch((e) => done(`error: ${e}`));
    });
    ok(!files.includes(".writer/chats"), `chat note leaked into search: ${files}`);
  });

  it("C: permission allow keeps the turn paused until answered", async function () {
    await send("[fake:permission-allow] write a file");
    await $('[aria-label="Permission required"]').waitForExist({ timeout: 15_000 });
    await shot("C-permission");
    await clickButton("Allow once");
    await $('[aria-label="Permission required"]').waitForExist({ timeout: 15_000 });
    await clickButton("Allow once");
    await browser.waitUntil(
      async () => !(await $('[aria-label="Permission required"]').isExisting()),
      {
        timeout: 15_000,
        timeoutMsg: "the permission card never went away",
      },
    );
    // the allowed Write created notes.txt: the turn ends with a Changes card for it
    const card = await $("[data-agent-changes]");
    await card.waitForExist({ timeout: 20_000 });
    ok(/1 file changed/.test(await card.getText()), `Changes card: ${await card.getText()}`);
    await shot("C-changes");
  });

  it("D: permission deny", async function () {
    await send("[fake:permission-deny] run it");
    await $('[aria-label="Permission required"]').waitForExist({ timeout: 15_000 });
    await clickButton("Deny once");
    await waitTranscript(/Denied|declined/i);
  });

  it("E: stop ends a streaming turn and the chat stays usable", async function () {
    await send("[fake:slow] take your time");
    const stop = await $('button[aria-label="Stop"]');
    await stop.waitForExist({ timeout: 10_000 });
    await stop.click();
    await browser.waitUntil(async () => !(await $('button[aria-label="Stop"]').isExisting()), {
      timeout: 15_000,
      timeoutMsg: "turn did not stop",
    });
    await send("[fake:plain] after stop");
    await waitTranscript(/FAKE-CLAUDE-REPLY: after stop/);
  });

  it("F: a crash mid-turn shows an error and does not hang the pane", async function () {
    await send("[fake:crash] boom");
    await $("[data-agent-error]").waitForExist({ timeout: 20_000 });
    await shot("F-crash");
  });

  it("G: History lists the chat and reopens it after an app restart", async function () {
    await browser.reloadSession();
    await $('button[aria-label="Hide sidebar"]').waitForExist({ timeout: 30_000 });
    await openPane();
    await runCommand("agent-history");
    const row = await $("[data-agent-history-row]");
    await row.waitForExist({ timeout: 15_000 });
    strictEqual(
      (await row.getText()).includes("hello from the e2e"),
      true,
      "the chat is listed by its first message",
    );
    await shot("G-history");
    await row.$("button").click();
    await waitTranscript(/FAKE-CLAUDE-REPLY: hello from the e2e/);
    // The next send resumes the CLI session (or reseeds when the fake lost it).
    await send("[fake:plain] resumed");
    await waitTranscript(/FAKE-CLAUDE-REPLY: resumed/);
    const log = readFileSync(FAKE_LOG, "utf8");
    ok(log.includes("--resume"), "a later spawn used --resume");
  });

  it("H: History regenerates a title from the saved note through the row menu", async function () {
    const titleCalls = () =>
      readFileSync(FAKE_LOG, "utf8")
        .split("\n")
        .filter((l) => l.includes('"ev":"title"')).length;
    const before = titleCalls();
    await runCommand("agent-history");
    const row = await $("[data-agent-history-row]");
    await row.waitForExist({ timeout: 15_000 });
    await row.$('button[aria-label="More actions"]').click();
    const entry = await $('[role="menuitem"]=Regenerate title');
    await entry.waitForExist({ timeout: 5_000 });
    await entry.click();
    await browser.waitUntil(() => titleCalls() === before + 1, {
      timeout: 20_000,
      timeoutMsg: "no one-shot title call after Regenerate title",
    });
    await browser.waitUntil(async () => (await row.getText()).includes("Fake chat title"), {
      timeout: 20_000,
      timeoutMsg: "the row never showed the regenerated title",
    });
    const note = readdirSync(CHATS()).find((f) => f.endsWith(".md"));
    ok(note, "the chat note is still on disk");
    ok(readFileSync(join(CHATS(), note), "utf8").includes("writer-chat-title-auto: true"));
    await shot("H-regenerate");
  });
});
