// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const hoisted = vi.hoisted(() => ({
  saveImage: vi.fn(),
  importImageFile: vi.fn(),
  opened: [] as (string | string[])[],
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
  convertFileSrc: (p: string) => `asset://localhost${p}`,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(async () => true), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({ get: async () => undefined, set: async () => {} })),
}));
vi.mock("@/lib/tauri", () => ({
  fuzzySearch: vi.fn(async () => []),
  resolveWikiLinkTarget: vi.fn(),
  recentLogErrors: vi.fn(async () => []),
  openLogFolder: vi.fn(),
  fileExists: vi.fn(async () => true),
  findFilesByExactName: vi.fn(async () => []),
}));
vi.mock("@/hooks/workspace-api", async (orig) => ({
  ...(await orig<object>()),
  getWorkspaceRoot: () => "/v",
}));
vi.mock("@/hooks/editor-api", async (orig) => ({
  ...(await orig<object>()),
  navigateToFile: (p: string) => void hoisted.opened.push(p.replace("/v/", "")),
  openFileInNewTab: (p: string, o?: { activate?: boolean }) =>
    void hoisted.opened.push([p.replace("/v/", ""), o?.activate === false ? "bg" : "tab"]),
}));
vi.mock("@features/agent/web/lib/chat-history-client", async (orig) => {
  const real = await orig<typeof import("@features/agent/web/lib/chat-history-client")>();
  return {
    ...real,
    chatHistoryClient: {
      ...real.chatHistoryClient,
      saveImage: hoisted.saveImage,
      importImageFile: hoisted.importImageFile,
    },
  };
});

import { AgentPane } from "@features/agent/web/components/agent-pane";
import { dropOnChatComposer } from "@features/agent/web/lib/chat-image-target";
import {
  DOCUMENT_MAX_PAGES,
  IMAGE_TOKEN_ESTIMATE,
  attachChatFiles,
  chatFileRef,
  chatFilesOfTransfer,
  isChatFileRef,
  pageRefusal,
  refusal,
  type ChatFileIo,
} from "@features/agent/web/lib/chat-files";
import { serviceContributions } from "@/lib/features/services";
import { chatFromNote } from "@features/agent/web/lib/chat-from-note";
import { parseChatNote, serializeChatNote, emptyMeta } from "@features/agent/web/lib/chat-note";
import { recordSend, type NoteState } from "@features/agent/web/lib/chat-persist";
import { buildPrompt } from "@features/agent/web/lib/context-text";
import { createMockAgentClient, type Goldens } from "@features/agent/web/lib/mock-client";
import {
  configureAgentRuntimeForTests,
  useAgentStore,
} from "@features/agent/web/stores/agent-store";
import { AGENT_PANE_DEFAULT_WIDTH, usePaneStore } from "@features/agent/web/stores/pane-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { UserTurnCard } from "@features/agent/web/components/user-turn-card";
import { composerView, pressKey } from "@features/agent/tests/helpers/agent-composer";
import { goldens } from "@features/agent/tests/helpers/agent-goldens";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const IMG = { kind: "image", path: ".writer/chats/assets/a.png" } as const;
const file = (name: string, type: string, size = 4) => {
  const f = new File([new Uint8Array(size)], name, { type });
  return f;
};

describe("attaching images to a chat draft", () => {
  const io = (over: Partial<ChatFileIo> = {}): ChatFileIo => ({
    projectPath: null,
    saveImage: vi.fn(async (_p, name) => ({ path: `.writer/chats/assets/${name}`, name })),
    importImageFile: vi.fn(async (_p, src) => ({
      path: `.writer/chats/assets/${src.split("/").pop()}`,
      name: "x",
    })),
    readBase64: vi.fn(async () => "AAAA"),
    ...over,
  });

  it("saves pasted bytes under a dated name, copies Finder files, references vault files", async () => {
    const i = io();
    const r = await attachChatFiles(
      [
        { kind: "file", file: file("image.png", "image/png") },
        { kind: "file", file: file("shot.webp", "image/webp") },
        { kind: "path", path: "/Users/me/Desktop/photo.jpg" },
        { kind: "vault", path: "pics/chart.gif" },
      ],
      i,
      new Date(2026, 10, 17, 9, 12, 5),
    );
    expect(r.notices).toEqual([]);
    expect(r.refs.map((x) => x.path)).toEqual([
      ".writer/chats/assets/Pasted image 20261117091205.png",
      ".writer/chats/assets/shot.webp",
      ".writer/chats/assets/photo.jpg",
      "pics/chart.gif",
    ]);
    expect(i.saveImage).toHaveBeenCalledTimes(2);
    expect(i.importImageFile).toHaveBeenCalledWith(null, "/Users/me/Desktop/photo.jpg");
  });

  it("refuses unsupported types and oversize files with a notice and keeps the rest", async () => {
    const i = io();
    const big = file("big.png", "image/png", 51 * 1024 * 1024);
    const r = await attachChatFiles(
      [
        { kind: "file", file: file("a.svg", "image/svg+xml") },
        { kind: "path", path: "/x/b.heic" },
        { kind: "vault", path: "pics/c.bmp" },
        { kind: "file", file: big },
        { kind: "file", file: file("ok.png", "image/png") },
      ],
      i,
    );
    expect(r.refs.map((x) => x.path)).toEqual([".writer/chats/assets/ok.png"]);
    expect(r.notices).toHaveLength(4);
    expect(r.notices[0]).toMatch(/a\.svg is not an image or PDF Claude can read/);
    expect(r.notices[3]).toMatch(/big\.png is over the \d+ MB limit/);
    expect(i.saveImage).toHaveBeenCalledTimes(1); // oversize bytes never cross the IPC
    expect(refusal("a.png", 1)).toBeNull();
  });

  it("turns a failed save into a notice without losing the other images", async () => {
    const i = io({
      saveImage: vi
        .fn()
        .mockRejectedValueOnce(new Error("disk full"))
        .mockResolvedValueOnce({ path: ".writer/chats/assets/b.png", name: "b.png" }),
    });
    const r = await attachChatFiles(
      [
        { kind: "file", file: file("a.png", "image/png") },
        { kind: "file", file: file("b.png", "image/png") },
      ],
      i,
    );
    expect(r.notices).toEqual(["Not attached: disk full"]);
    expect(r.refs.map((x) => x.path)).toEqual([".writer/chats/assets/b.png"]);
  });
});

describe("attaching PDFs to a chat draft", () => {
  const io = (over: Partial<ChatFileIo> = {}): ChatFileIo => ({
    projectPath: null,
    saveImage: vi.fn(async (_p, name) => ({ path: `.writer/chats/assets/${name}`, name })),
    importImageFile: vi.fn(async (_p, src) => ({
      path: `.writer/chats/assets/${src.split("/").pop()}`,
      name: "x",
    })),
    readBase64: vi.fn(async () => "AAAA"),
    ...over,
  });
  const pages = (n: number) => ({
    ofBytes: vi.fn(async () => n),
    ofPath: vi.fn(async () => n),
  });

  it("a PDF is a document ref, whichever way it arrives", async () => {
    const i = io();
    const r = await attachChatFiles(
      [
        { kind: "file", file: file("paper.pdf", "application/pdf") },
        { kind: "path", path: "/Users/me/Desktop/invoice.pdf" },
        { kind: "vault", path: "papers/survey.PDF" },
        { kind: "file", file: file("image.png", "image/png") },
      ],
      i,
      new Date(2026, 10, 17, 9, 12, 5),
    );
    expect(r.notices).toEqual([]);
    expect(r.refs).toEqual([
      { kind: "document", path: ".writer/chats/assets/paper.pdf" },
      { kind: "document", path: ".writer/chats/assets/invoice.pdf" },
      { kind: "document", path: "papers/survey.PDF" },
      { kind: "image", path: ".writer/chats/assets/Pasted image 20261117091205.png" },
    ]);
    expect(i.saveImage).toHaveBeenCalledTimes(2);
    expect(i.importImageFile).toHaveBeenCalledWith(null, "/Users/me/Desktop/invoice.pdf");
    expect(refs(chatFileRef("a.pdf"))).toBe("document");
    expect(refs(chatFileRef("a.png"))).toBe("image");
  });

  it("a nameless pasted PDF gets a dated name", async () => {
    const r = await attachChatFiles(
      [{ kind: "file", file: file("", "application/pdf") }],
      io(),
      new Date(2026, 10, 17, 9, 12, 5),
    );
    expect(r.refs[0]!.path).toBe(".writer/chats/assets/Pasted document 20261117091205.pdf");
  });

  it("refuses a PDF over the byte cap before its bytes cross the IPC", async () => {
    const i = io();
    const r = await attachChatFiles(
      [{ kind: "file", file: file("big.pdf", "application/pdf", 30 * 1024 * 1024) }],
      i,
    );
    expect(r.refs).toEqual([]);
    expect(r.notices[0]).toMatch(/big\.pdf is over the 22 MB PDF limit/);
    expect(i.saveImage).not.toHaveBeenCalled();
    expect(refusal("a.pdf", 1)).toBeNull();
    expect(refusal("a.pdf", 23 * 1024 * 1024)).toMatch(/PDF limit/);
  });

  it("refuses a PDF over the page cap, counting through the service, and keeps the rest", async () => {
    const counter = pages(DOCUMENT_MAX_PAGES + 1);
    const i = io({ pdfPages: counter });
    const r = await attachChatFiles(
      [
        { kind: "vault", path: "papers/long.pdf" },
        { kind: "file", file: file("long2.pdf", "application/pdf") },
        { kind: "path", path: "/x/long3.pdf" },
        { kind: "vault", path: "pics/ok.png" },
      ],
      i,
    );
    expect(r.refs.map((x) => x.path)).toEqual(["pics/ok.png"]);
    expect(r.notices).toHaveLength(3);
    expect(r.notices[0]).toBe("Not attached: long.pdf has 101 pages, Claude reads up to 100");
    expect(counter.ofPath).toHaveBeenCalledWith("papers/long.pdf", "vault");
    expect(counter.ofPath).toHaveBeenCalledWith("/x/long3.pdf", "path");
    expect(counter.ofBytes).toHaveBeenCalledOnce();
    expect(i.saveImage).not.toHaveBeenCalled(); // nothing saved for a refused PDF
    expect(i.importImageFile).not.toHaveBeenCalled();
  });

  it("accepts exactly the cap, and a PDF whose pages cannot be counted", async () => {
    const r = await attachChatFiles(
      [{ kind: "vault", path: "a.pdf" }],
      io({ pdfPages: pages(DOCUMENT_MAX_PAGES) }),
    );
    expect(r.refs).toHaveLength(1);
    const broken = {
      ofBytes: vi.fn(async () => Promise.reject(new Error("bad"))),
      ofPath: vi.fn(async () => Promise.reject(new Error("bad"))),
    };
    const r2 = await attachChatFiles([{ kind: "vault", path: "b.pdf" }], io({ pdfPages: broken }));
    expect(r2.refs).toHaveLength(1);
    expect(r2.notices).toEqual([]);
    expect(pageRefusal("a.pdf", null)).toBeNull();
  });

  it("without the PDF feature (no counter) a PDF is attached as is", async () => {
    const r = await attachChatFiles([{ kind: "vault", path: "a.pdf" }], io());
    expect(r.refs).toEqual([{ kind: "document", path: "a.pdf" }]);
  });

  it("a paste or drop carries PDFs too", () => {
    const pdf = file("paper.pdf", "application/pdf");
    const blob = file("", "application/pdf");
    const txt = file("a.txt", "text/plain");
    expect(chatFilesOfTransfer({ files: [pdf, blob, txt], items: [] } as never)).toEqual([
      pdf,
      blob,
    ]);
  });

  const refs = (r: { kind: string }) => r.kind;
  it("document refs are file refs", () => {
    expect(isChatFileRef({ kind: "document", path: "a.pdf" })).toBe(true);
    expect(isChatFileRef({ kind: "image", path: "a.png" })).toBe(true);
    expect(isChatFileRef({ kind: "note", path: "a.md" })).toBe(false);
  });
});

describe("what Claude is told", () => {
  it("lists a PDF in the references footer like an image, as a PDF", () => {
    const prompt = buildPrompt({
      text: "summarise",
      refs: [{ kind: "document", path: "papers/survey.pdf" }],
      cwd: null,
    });
    expect(prompt).toContain("- @papers/survey.pdf (PDF, also attached to this message)");
    expect(prompt.startsWith("summarise")).toBe(true);
  });

  it("lists each image path in the references footer, relative to the working directory", () => {
    const prompt = buildPrompt({
      text: "what is this?",
      refs: [IMG, { kind: "image", path: "Projects/Demo/pics/b.png" }],
      cwd: "Projects/Demo",
    });
    expect(prompt).toContain("<references>");
    expect(prompt).toContain(
      "- @../../.writer/chats/assets/a.png (image, also attached to this message)",
    );
    expect(prompt).toContain("- @pics/b.png (image, also attached to this message)");
    expect(prompt.startsWith("what is this?")).toBe(true);
  });
});

describe("PDFs in the chat note", () => {
  it("are kept with the message's files and come back as document refs", () => {
    const note = recordSend({ messages: [], pending: [] } as unknown as NoteState, {
      messageId: "m1",
      text: "read these",
      context: [
        { kind: "document", path: ".writer/chats/assets/paper.pdf" },
        { kind: "image", path: "pics/a.png" },
      ],
      ts: Date.UTC(2026, 10, 17, 9, 12),
    });
    const text = serializeChatNote({
      meta: emptyMeta("5328964b-5fe4-4e06-8843-5cf92bdc9e7c", 1),
      messages: note.messages,
      trimmed: 0,
      extraFrontmatter: "",
    });
    expect(text).toContain("![[.writer/chats/assets/paper.pdf]]\n![[pics/a.png]]\n\nread these");
    const user = chatFromNote(parseChatNote(text), { projectPath: null }).turns[0]!.user!;
    expect(user.text).toBe("read these");
    expect(user.context).toEqual([
      { kind: "document", path: ".writer/chats/assets/paper.pdf" },
      { kind: "image", path: "pics/a.png" },
    ]);
  });
});

describe("images in the chat note", () => {
  const send = (note: NoteState) =>
    recordSend(note, {
      messageId: "m1",
      text: "what is this?",
      context: [IMG, { kind: "image", path: "pics/b c.png" }, { kind: "note", path: "Plan.md" }],
      ts: Date.UTC(2026, 10, 17, 9, 12),
    });

  it("persists the attachments as embeds and gets them back on reopen", () => {
    const note = send({ messages: [], pending: [] } as unknown as NoteState);
    const text = serializeChatNote({
      meta: emptyMeta("5328964b-5fe4-4e06-8843-5cf92bdc9e7c", 1),
      messages: note.messages,
      trimmed: 0,
      extraFrontmatter: "",
    });
    expect(text).toContain("![[.writer/chats/assets/a.png]]\n![[pics/b c.png]]\n\nwhat is this?");
    expect(text).toContain("> context: [[Plan]]");
    const chat = chatFromNote(parseChatNote(text), { projectPath: null });
    const user = chat.turns[0]!.user!;
    expect(user.text).toBe("what is this?");
    expect(user.context).toEqual([IMG, { kind: "image", path: "pics/b c.png" }]);
    expect(user.contextLabel).toBe("[[Plan]]");
  });
});

describe("the composer and the transcript", () => {
  let container: HTMLElement;
  let root: Root;
  let mock: ReturnType<typeof createMockAgentClient>;
  const get = () => useAgentStore.getState();
  const flush = async (ms = 0) =>
    act(async () => void (await new Promise((r) => setTimeout(r, ms))));
  const $ = (sel: string) => container.querySelector<HTMLElement>(sel);
  const $$ = (sel: string) => [...container.querySelectorAll<HTMLElement>(sel)];
  const draft = () => get().drafts[get().activeChatId!]?.mentions ?? [];

  beforeEach(async () => {
    mock = createMockAgentClient({ goldens: goldens as unknown as Goldens, delayMs: 0 });
    configureAgentRuntimeForTests(mock);
    useWorkspaceStore.setState({ root: "/v" } as never);
    usePaneStore.setState({ open: false, width: AGENT_PANE_DEFAULT_WIDTH });
    useAgentStore.setState({
      chats: {},
      order: [],
      activeChatId: null,
      drafts: {},
      queued: {},
      modes: {},
      view: "chat",
      backend: "tauri",
      binary: {
        found: true,
        path: "/x",
        version: "1",
        source: "path",
        searched: [],
        authenticated: true,
        account: null,
      },
    });
    hoisted.saveImage.mockReset();
    hoisted.saveImage.mockImplementation(async (_p: unknown, name: string) => ({
      path: `.writer/chats/assets/${name}`,
      name,
    }));
    hoisted.opened.length = 0;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => get().openPane());
    await act(async () => root.render(<AgentPane />));
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const paste = (files: File[], text = "") => {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.assign(event, {
      clipboardData: {
        files,
        items: [],
        getData: (t: string) => (t === "text/plain" ? text : ""),
      },
    });
    composerView(container).contentDOM.dispatchEvent(event);
    return event;
  };

  it("a pasted image becomes a chip with a thumbnail; the x removes it", async () => {
    const event = paste([file("image.png", "image/png")]);
    expect(event.defaultPrevented).toBe(true);
    await flush(5);
    expect(hoisted.saveImage).toHaveBeenCalledOnce();
    const chip = $("[data-agent-chip-image]")!;
    expect(chip).not.toBeNull();
    expect(chip.querySelector("[data-agent-image-thumb]")!.getAttribute("src")).toMatch(
      /^asset:\/\/localhost\/v\/\.writer\/chats\/assets\/Pasted image \d{14}\.png$/,
    );
    expect(chip.querySelector("button")!.getAttribute("title")).toContain(
      `${IMAGE_TOKEN_ESTIMATE.toLocaleString("en-US")} tokens`,
    );
    expect(draft()).toHaveLength(1);
    act(() => (chip.querySelector("button[aria-label^='Remove']") as HTMLElement).click());
    expect(draft()).toHaveLength(0);
    expect($("[data-agent-chip-image]")).toBeNull();
  });

  it("a screenshot on the clipboard (an item, no entry in files) is saved and attached", async () => {
    const shot = file("image.png", "image/png");
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.assign(event, {
      clipboardData: {
        files: [],
        items: [{ kind: "file", type: "image/png", getAsFile: () => shot }],
        getData: () => "",
      },
    });
    composerView(container).contentDOM.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await flush(5);
    expect(hoisted.saveImage).toHaveBeenCalledOnce();
    expect(hoisted.saveImage.mock.calls[0]![1]).toMatch(/^Pasted image \d{14}\.png$/);
    expect($("[data-agent-chip-image] [data-agent-image-thumb]")).not.toBeNull();
  });

  it("clicking an image chip opens the image tab through link activation", async () => {
    paste([file("image.png", "image/png")]);
    await flush(5);
    const open = $("[data-agent-chip-image] button[title]") as HTMLElement;
    act(() => open.click());
    expect(hoisted.opened).toHaveLength(1);
    expect(hoisted.opened[0]).toMatch(/^\.writer\/chats\/assets\/Pasted image \d{14}\.png$/);
  });

  it("several images attach; Backspace at the start removes the last one", async () => {
    paste([file("a.png", "image/png"), file("b.jpg", "image/jpeg")]);
    await flush(5);
    expect($$("[data-agent-chip-image]")).toHaveLength(2);
    pressKey(composerView(container), "Backspace");
    expect(draft().map((r) => ("path" in r ? r.path : ""))).toEqual([".writer/chats/assets/a.png"]);
    pressKey(composerView(container), "Backspace");
    expect(draft()).toHaveLength(0);
  });

  it("an unsupported or oversize image shows a notice and attaches nothing", async () => {
    paste([file("a.svg", "image/svg+xml")]);
    await flush(5);
    expect(draft()).toHaveLength(0);
    expect($("[data-agent-image-notice]")!.textContent).toMatch(
      /a\.svg is not an image or PDF Claude/,
    );
    paste([file("big.png", "image/png", 51 * 1024 * 1024)]);
    await flush(5);
    expect($("[data-agent-image-notice]")!.textContent).toMatch(/over the \d+ MB limit/);
    expect(hoisted.saveImage).not.toHaveBeenCalled();
  });

  describe("a PDF", () => {
    let remove: (() => void) | null = null;
    const withCounter = (n: number) => {
      remove = serviceContributions.add("pdf.info", {
        owner: "test",
        id: "pdf.info",
        service: {
          pageCountOfBytes: async () => n,
          pageCountOfPath: async () => n,
        },
      });
    };
    afterEach(() => remove?.());

    it("pasted becomes a PDF chip with its name; click opens the PDF tab; the x removes it", async () => {
      const event = paste([file("paper.pdf", "application/pdf")]);
      expect(event.defaultPrevented).toBe(true);
      await flush(5);
      expect(hoisted.saveImage).toHaveBeenCalledOnce();
      const chip = $("[data-agent-chip-pdf]")!;
      expect(chip).not.toBeNull();
      expect(chip.querySelector("[data-agent-image-thumb]")).toBeNull();
      expect(chip.textContent).toContain("paper.pdf");
      expect(chip.textContent).not.toContain("page"); // no PDF feature, no count
      expect(draft()).toEqual([{ kind: "document", path: ".writer/chats/assets/paper.pdf" }]);
      act(() => (chip.querySelector("button[title]") as HTMLElement).click());
      expect(hoisted.opened).toEqual([".writer/chats/assets/paper.pdf"]);
      act(() => (chip.querySelector("button[aria-label^='Remove']") as HTMLElement).click());
      expect(draft()).toHaveLength(0);
    });

    it("shows its page count once the PDF feature has counted it", async () => {
      withCounter(12);
      paste([file("survey.pdf", "application/pdf")]);
      await flush(5);
      expect($("[data-agent-chip-pdf]")!.textContent).toContain("survey.pdf · 12 pages");
    });

    it("over 100 pages it is refused with one line and nothing is saved", async () => {
      withCounter(250);
      paste([file("huge.pdf", "application/pdf")]);
      await flush(5);
      expect(draft()).toHaveLength(0);
      expect(hoisted.saveImage).not.toHaveBeenCalled();
      expect($("[data-agent-image-notice]")!.textContent).toMatch(
        /huge\.pdf has 250 pages, Claude reads up to 100/,
      );
    });

    it("is sent as a document ref with a line in the references, and shown as a chip in the card", async () => {
      paste([file("paper.pdf", "application/pdf")]);
      await flush(5);
      const sent = vi.spyOn(mock, "send");
      await act(async () => await get().sendMessage("summarise it"));
      await flush(5);
      expect(sent.mock.calls[0]![0].context).toContainEqual({
        kind: "document",
        path: ".writer/chats/assets/paper.pdf",
      });
      expect(sent.mock.calls[0]![0].text).toContain("(PDF, also attached to this message)");
      expect(draft()).toHaveLength(0);
      const card = $("[data-agent-user-turn]")!;
      expect(card.querySelectorAll("[data-agent-turn-pdf]")).toHaveLength(1);
      expect(card.querySelector("[data-agent-turn-pdf]")!.textContent).toContain("paper.pdf");
      act(() => (card.querySelector("[data-agent-turn-pdf]") as HTMLElement).click());
      expect(hoisted.opened).toEqual([".writer/chats/assets/paper.pdf"]);
    });

    it("Backspace at the start removes a PDF chip like an image chip", async () => {
      paste([file("paper.pdf", "application/pdf")]);
      await flush(5);
      pressKey(composerView(container), "Backspace");
      expect(draft()).toHaveLength(0);
    });

    it("a vault PDF dropped from the sidebar is referenced in place", async () => {
      const over = vi
        .spyOn($("[data-agent-composer-box]")!.parentElement!, "getBoundingClientRect")
        .mockReturnValue({ left: 0, right: 100, top: 0, bottom: 100 } as DOMRect);
      expect(dropOnChatComposer(10, 10, [{ kind: "vault", path: "/v/papers/survey.pdf" }])).toBe(
        true,
      );
      await flush(5);
      over.mockRestore();
      expect(draft()).toEqual([{ kind: "document", path: "papers/survey.pdf" }]);
      expect(hoisted.saveImage).not.toHaveBeenCalled();
    });
  });

  it("a vault image dropped from the sidebar is referenced in place, nothing is saved", async () => {
    const over = vi
      .spyOn($("[data-agent-composer-box]")!.parentElement!, "getBoundingClientRect")
      .mockReturnValue({ left: 0, right: 100, top: 0, bottom: 100 } as DOMRect);
    expect(dropOnChatComposer(500, 500, [{ kind: "vault", path: "/v/pics/chart.png" }])).toBe(
      false,
    );
    expect(dropOnChatComposer(10, 10, [{ kind: "vault", path: "/v/pics/chart.png" }])).toBe(true);
    await flush(5);
    over.mockRestore();
    expect(draft()).toEqual([{ kind: "image", path: "pics/chart.png" }]);
    expect(hoisted.saveImage).not.toHaveBeenCalled();
  });

  it("sends the images with the message, shows thumbnails in the card and clears the chips", async () => {
    paste([file("a.png", "image/png")]);
    await flush(5);
    const sent = vi.spyOn(mock, "send");
    await act(async () => await get().sendMessage("describe it"));
    await flush(5);
    expect(sent.mock.calls[0]![0].context).toContainEqual({
      kind: "image",
      path: ".writer/chats/assets/a.png",
    });
    expect(sent.mock.calls[0]![0].text).toContain("(image, also attached to this message)");
    expect(draft()).toHaveLength(0);
    const card = $("[data-agent-user-turn]")!;
    expect(card.querySelectorAll("[data-agent-turn-images] [data-agent-image-thumb]")).toHaveLength(
      1,
    );
  });

  it("a restored chat shows the thumbnails, and a click opens the image", () => {
    const chat = chatFromNote(
      parseChatNote(
        serializeChatNote({
          meta: emptyMeta("5328964b-5fe4-4e06-8843-5cf92bdc9e7c", 1),
          messages: [
            {
              role: "user",
              id: "m1",
              at: Date.UTC(2026, 10, 17, 9, 12),
              text: "what is this?",
              images: [".writer/chats/assets/a.png"],
              context: "[[Plan]]",
            },
          ],
          trimmed: 0,
          extraFrontmatter: "",
        }),
      ),
      { projectPath: null },
    );
    const host = document.createElement("div");
    document.body.appendChild(host);
    const r = createRoot(host);
    act(() => r.render(<UserTurnCard message={chat.turns[0]!.user!} />));
    const thumb = host.querySelector("[data-agent-turn-images] button")!;
    expect(thumb.querySelector("[data-agent-image-thumb]")).not.toBeNull();
    expect(host.textContent).toContain("[[Plan]]"); // the label still shows next to the images
    act(() => (thumb as HTMLElement).click());
    expect(hoisted.opened).toEqual([".writer/chats/assets/a.png"]);
    act(() => {
      thumb.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    });
    expect(hoisted.opened.at(-1)).toEqual([".writer/chats/assets/a.png", "bg"]);
    act(() => r.unmount());
    host.remove();
  });
});
