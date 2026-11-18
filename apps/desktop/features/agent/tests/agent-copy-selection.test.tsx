// @vitest-environment jsdom
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const writeText = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText }));

import { useEditorNoticeStore } from "@/components/editor-area/editor-notice-store";
import { useSettingsStore } from "@/stores/settings-store";
import { AssistantText } from "@features/agent/web/components/assistant-text";
import { UserTurnCard } from "@features/agent/web/components/user-turn-card";
import { useCopySelection } from "@features/agent/web/hooks/use-copy-selection";
import type { TextBlock } from "@features/agent/web/lib/transcript";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let n = 0;
const block = (text: string) =>
  ({ kind: "text", id: `b${n++}`, messageId: "m", blockIndex: 0, text, final: true }) as TextBlock;

function Harness({ texts, user }: { texts: string[]; user?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useCopySelection(ref);
  return (
    <>
      <div ref={ref} data-agent-transcript>
        {user && (
          <UserTurnCard message={{ messageId: "u", text: user, context: [], ts: 0 } as never} />
        )}
        {texts.map((t, i) => (
          <AssistantText key={i} block={block(t)} />
        ))}
      </div>
      <textarea data-composer defaultValue="draft text" />
    </>
  );
}

describe("copy from the agent transcript", () => {
  let container: HTMLElement;
  let root: Root;
  beforeEach(() => {
    vi.useFakeTimers();
    writeText.mockClear();
    useEditorNoticeStore.setState({ message: null });
    useSettingsStore.setState({ settings: {} } as never);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.getSelection()?.removeAllRanges();
    vi.useRealTimers();
  });

  const render = (texts: string[], user?: string) =>
    act(() => root.render(<Harness texts={texts} user={user} />));
  const text = (el: Element) => {
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const out: Text[] = [];
    for (let t = w.nextNode(); t; t = w.nextNode()) out.push(t as Text);
    return out;
  };
  const selectRange = (a: Node, ao: number, b: Node, bo: number) => {
    const r = document.createRange();
    r.setStart(a, ao);
    r.setEnd(b, bo);
    const s = document.getSelection()!;
    s.removeAllRanges();
    s.addRange(r);
  };
  const selectContents = (el: Node) => {
    const r = document.createRange();
    r.selectNodeContents(el);
    const s = document.getSelection()!;
    s.removeAllRanges();
    s.addRange(r);
  };
  const finish = async () => {
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(5);
  };
  const hosts = () => [...container.querySelectorAll<HTMLElement>("[data-md-host]")];

  it("copies the exact source of a whole message and shows the toast once", async () => {
    const source = "# Title\n\nSome **bold** text\n\n- one\n- two";
    render([source]);
    selectContents(hosts()[0]!);
    await finish();
    expect(writeText).toHaveBeenCalledExactlyOnceWith(source);
    expect(useEditorNoticeStore.getState().message).toBe("Copied to clipboard");
    await finish(); // the same selection again: nothing new
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it("copies Markdown for a partial selection with bold and a link", async () => {
    render(["Some **bold** and a [link](https://x.dev) here"]);
    const p = container.querySelector("p")!;
    const t = text(p);
    selectRange(t[0]!, 2, t[2]!, 4); // "me " + bold + " and"
    await finish();
    expect(writeText).toHaveBeenLastCalledWith("me **bold** and");

    selectContents(p.querySelector("strong")!); // exactly the bold text
    document.getSelection()!.removeAllRanges();
    const strong = text(p.querySelector("strong")!)[0]!;
    selectRange(strong, 0, strong, 4);
    await finish();
    expect(writeText).toHaveBeenLastCalledWith("**bold**");

    const link = text(p.querySelector("a")!)[0]!;
    selectRange(link, 1, link, 3); // inside the link text: the whole link
    await finish();
    expect(writeText).toHaveBeenLastCalledWith("[link](https://x.dev)");
  });

  it("copies a code block as fenced code with its language", async () => {
    const code = "```ts\nconst a = 1;\n```";
    render([`Before\n\n${code}\n\nAfter`]);
    selectContents(container.querySelector("pre")!);
    await finish();
    expect(writeText).toHaveBeenLastCalledWith(code);
  });

  it("copies two messages separated by a blank line", async () => {
    render(["Second **answer**"], "First *question*");
    const hs = hosts();
    selectRange(text(hs[0]!)[0]!, 0, text(hs[1]!).at(-1)!, text(hs[1]!).at(-1)!.length);
    await finish();
    expect(writeText).toHaveBeenLastCalledWith("First *question*\n\nSecond **answer**");
  });

  it("ignores the composer, a collapsed selection and a selection leaving the transcript", async () => {
    render(["Hello world"]);
    const area = container.querySelector("textarea")!;
    area.focus();
    area.setSelectionRange(0, 5);
    await finish();
    const t = text(hosts()[0]!)[0]!;
    selectRange(t, 3, t, 3);
    await finish();
    selectRange(t, 0, area, 0);
    await finish();
    expect(writeText).not.toHaveBeenCalled();
    expect(useEditorNoticeStore.getState().message).toBeNull();
  });

  it("gives the same Markdown on Cmd/Ctrl+C, without the toast", () => {
    render(["Some **bold** and [[Note|Alias]] here"]);
    selectContents(hosts()[0]!);
    const setData = vi.fn();
    const event = new Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { setData } });
    document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(setData).toHaveBeenCalledWith("text/plain", "Some **bold** and Alias here");
    expect(useEditorNoticeStore.getState().message).toBeNull();
  });

  it("removes wiki links from the auto copy", async () => {
    render(["see [[folder/Note#Part]] and ![[pic.png]] ok"]);
    selectContents(hosts()[0]!);
    await finish();
    expect(writeText).toHaveBeenLastCalledWith("see Note > Part and ok");
  });

  it("turning copy-on-select off stops the auto copy only", async () => {
    useSettingsStore.setState({ settings: { "agent.copy-on-select": false } } as never);
    render(["Hello world"]);
    selectContents(hosts()[0]!);
    await finish();
    expect(writeText).not.toHaveBeenCalled();
    const setData = vi.fn();
    const event = new Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { setData } });
    document.dispatchEvent(event);
    expect(setData).toHaveBeenCalledWith("text/plain", "Hello world");
  });

  it("puts a copy button on every code block that copies the inner text, nested fences intact", async () => {
    const inner = "# Title\n\n```js\nx()\n```\n\n  indented";
    render([`Intro\n\n\`\`\`\`markdown\n${inner}\n\`\`\`\`\n\n\`\`\`sh\nls\n\`\`\``]);
    const buttons = [...container.querySelectorAll<HTMLButtonElement>("pre button")];
    expect(buttons).toHaveLength(2);
    for (const b of buttons) {
      expect(b.getAttribute("aria-label")).toBe("Copy code");
      expect(b.title).toBe("Copy");
      expect(b.type).toBe("button");
    }
    buttons[0]!.focus();
    expect(document.activeElement).toBe(buttons[0]);
    await act(async () => buttons[0]!.click());
    expect(writeText).toHaveBeenCalledExactlyOnceWith(inner);
    expect(useEditorNoticeStore.getState().message).toBe("Copied to clipboard");
    await act(async () => buttons[1]!.click());
    expect(writeText).toHaveBeenLastCalledWith("ls");
  });

  it("does not put the button's label into a copied selection", async () => {
    render(["```ts\nlet a\n```"]);
    const code = text(container.querySelector("code")!)[0]!;
    selectRange(code, 0, code, 3);
    await finish();
    expect(writeText).toHaveBeenLastCalledWith("let");
  });

  it("maps a partial selection of a user message with a pill back to the typed text", async () => {
    render([], "fix @Plan.md and **go** now");
    const h = hosts()[0]!;
    const nodes = text(h).filter((t) => !t.parentElement?.closest("[data-pill-slot]"));
    const strong = text(h.querySelector("strong")!)[0]!;
    selectRange(nodes[1]!, 1, strong, 2); // "and " .. "go"
    await finish();
    expect(writeText).toHaveBeenLastCalledWith("and **go**");
  });

  it("falls back to the selected text when the source cannot be mapped (CRLF)", async () => {
    render(["one **two**\r\n\r\nthree"]);
    const t = text(hosts()[0]!)[0]!;
    selectRange(t, 0, t, 3);
    await finish();
    expect(writeText).toHaveBeenLastCalledWith("one");
  });
});
