// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const open = vi.hoisted(() => vi.fn());
vi.mock("../src/components/agent/agent-links", () => ({
  openVaultPath: open,
  handleMarkdownClick: () => {},
}));

import { renderUserMessage } from "../src/components/agent/message-text";
import { UserTurnCard } from "../src/components/agent/user-turn-card";
import type { ContextRef } from "../src/lib/agent/events";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("user message tokens", () => {
  let container: HTMLElement;
  let root: Root;
  beforeEach(() => {
    open.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });
  const render = (text: string, context: ContextRef[]) =>
    act(() =>
      root.render(<UserTurnCard message={{ messageId: "m", text, context, ts: 0 } as never} />),
    );
  const tokens = () => [...container.querySelectorAll<HTMLElement>("[data-agent-token]")];

  it("styles @refs and /skills inline, keeps the typed text, opens notes on click", () => {
    render(
      'compare @Projects/Plan.md with @activenote and @Docs and @"My Plan.md" then /summarize',
      [
        { kind: "active-note", path: "Notes/Today.md", inline: false },
        { kind: "note", path: "Projects/Plan.md" },
        { kind: "folder", path: "Docs" },
        { kind: "note", path: "My Plan.md" },
      ],
    );
    // pills show the readable label; the typed token text is the composer document's, not the DOM's
    expect(tokens().map((t) => [t.dataset.agentToken, t.dataset.pillKind, t.textContent])).toEqual([
      ["mention", "note", "Plan"],
      ["mention", "active-note", "Today"],
      ["mention", "folder", "Docs"],
      ["mention", "note", "My Plan"],
      ["skill", "skill", "/summarize"],
    ]);
    act(() => tokens()[0]!.click());
    expect(open).toHaveBeenLastCalledWith("Projects/Plan.md");
    act(() => tokens()[1]!.click());
    expect(open).toHaveBeenLastCalledWith("Notes/Today.md");
    act(() => tokens()[3]!.click());
    expect(open).toHaveBeenLastCalledWith("My Plan.md");
    expect(tokens()[2]!.tagName).toBe("SPAN"); // a folder is not a button
    expect(tokens()[4]!.tagName).toBe("SPAN");
  });

  it("shows the readable name with the full path as tooltip and opens that path", () => {
    const path = "Management/2026-11-16 - Daniel Plan.md";
    render('prep @"Daniel Plan"', [{ kind: "note", path, label: "Daniel Plan" }]);
    const t = tokens()[0]!;
    expect(t.textContent).toBe("Daniel Plan");
    expect(t.title).toBe(path);
    act(() => t.click());
    expect(open).toHaveBeenLastCalledWith(path);
  });

  it("leaves @activenote inert when the note it meant is unknown (a reopened chat)", () => {
    render("see @activenote and @Nothing", []);
    expect(tokens()[0]!.tagName).toBe("SPAN");
    expect(tokens().map((t) => t.dataset.resolved)).toEqual(["false", "false"]); // muted
  });

  it("renders Markdown in the editor's typography and keeps pills inside it", () => {
    render(
      [
        "# Plan",
        "",
        "Compare **@Projects/Plan.md** with `code` and ~~old~~",
        "second line",
        "",
        "- [ ] task one",
        "- see @Docs",
        "",
        "> quoted /summarize",
        "",
        "```ts",
        "let a = 1;",
        "```",
        "",
        "[site](https://example.com) and [[Wiki Note]]",
      ].join("\n"),
      [
        { kind: "note", path: "Projects/Plan.md" },
        { kind: "folder", path: "Docs" },
      ],
    );
    const md = container.querySelector(".agent-markdown")!;
    expect(md.querySelector("h1")!.textContent).toBe("Plan");
    expect(md.querySelector("strong [data-agent-token]")!.textContent).toBe("Plan");
    expect(md.querySelector("code")!.textContent).toBe("code");
    expect(md.querySelector("del")!.textContent).toBe("old");
    expect(md.querySelectorAll("p br").length).toBeGreaterThan(0); // one newline stays a line break
    expect(md.querySelectorAll("ul li")).toHaveLength(2);
    expect(md.querySelector("li [data-pill-kind='folder']")).not.toBeNull();
    expect(md.querySelector("blockquote [data-pill-kind='skill']")!.textContent).toBe("/summarize");
    expect(md.querySelector("pre code")!.textContent).toContain("let a = 1;");
    expect(md.querySelector("a[href='https://example.com']")!.textContent).toBe("site");
    expect(md.querySelector("a[href='#wikilink:Wiki%20Note']")).not.toBeNull();
    expect(tokens().map((t) => t.dataset.agentToken)).toEqual(["mention", "mention", "skill"]);
    act(() => tokens()[0]!.click());
    expect(open).toHaveBeenLastCalledWith("Projects/Plan.md");
  });

  it("plain text stays plain: same words, pills in place, no stray markup", () => {
    render("just a plain line with @Docs", [{ kind: "folder", path: "Docs" }]);
    expect(container.querySelector(".agent-markdown")!.innerHTML).toMatch(
      /^<p>just a plain line with <span data-pill-slot="0">.*<\/span><\/p>\n?$/s,
    );
  });
});

describe("renderUserMessage", () => {
  it("keeps tokens out of Markdown (underscores, asterisks) and out of attributes", () => {
    const r = renderUserMessage('see @"my_file_name_*x*.md" and [t](@Docs)', [
      { kind: "note", path: "my_file_name_*x*.md" },
    ]);
    expect(r.pills).toHaveLength(2);
    expect(r.html).toContain('<span data-pill-slot="0"></span>');
    expect(r.html).not.toContain("<em>");
    expect(r.html).not.toMatch(/[\uE000\uE001]/);
  });

  it("escapes HTML and never lets raw tags through", () => {
    const r = renderUserMessage("<img src=x onerror=alert(1)> <b>x</b>", []);
    expect(r.html).not.toContain("<img");
    expect(r.html).not.toContain("<b>");
  });
});
