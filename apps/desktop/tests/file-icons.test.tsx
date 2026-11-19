// @vitest-environment jsdom
// The one hook every surface asks for a file's icon (`lib/file-icons.ts`): paths absolute or
// vault-relative reach the same entry, nothing without the feature, links resolve through the
// vault resolver (cached, and not at all while no icon exists), and the DOM drawing the CodeMirror
// widgets use. Spec: SPECs/icons-spec.md.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const resolveWikiLinkTarget = vi.hoisted(() => vi.fn());
vi.mock("@/lib/tauri", () => ({ resolveWikiLinkTarget }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));

import {
  clearFileIcons,
  fileIconOf,
  resetFileIconsForTests,
  resolveLinkPath,
  setFileIcons,
  useFileIcon,
  useLinkIcon,
  watchLinkIcon,
  type FileIconEntry,
} from "@/lib/file-icons";
import { fillIconElement } from "@/lib/icon-picker/icon-dom";
import { useWorkspaceStore } from "@/stores/workspace-store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;

function Probe({ path }: { path: string | null }) {
  const icon = useFileIcon(path);
  return <span data-probe>{icon ? `${icon.icon}|${icon.color ?? ""}` : "none"}</span>;
}
function LinkProbe({ target, source }: { target: string; source?: string }) {
  const icon = useLinkIcon(target, source);
  return <span data-probe>{icon ? icon.icon : "none"}</span>;
}
const text = () => container.querySelector("[data-probe]")!.textContent;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  useWorkspaceStore.setState({ root: "/vault" });
  resetFileIconsForTests();
  resolveWikiLinkTarget.mockReset();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("useFileIcon", () => {
  it("is the same entry for an absolute path and the vault-relative one, files and folders", async () => {
    setFileIcons([
      { path: "Notes/Idea.md", icon: "emoji:🚀", color: "#ff0000" },
      { path: "Notes", icon: "icon:Folder01Icon" },
    ]);
    await act(async () => root.render(<Probe path="/vault/Notes/Idea.md" />));
    expect(text()).toBe("emoji:🚀|#ff0000");
    await act(async () => root.render(<Probe path="Notes/Idea.md" />));
    expect(text()).toBe("emoji:🚀|#ff0000");
    await act(async () => root.render(<Probe path="/vault/Notes" />));
    expect(text()).toBe("icon:Folder01Icon|");
    expect(fileIconOf("/vault/Notes")?.icon).toBe("icon:Folder01Icon");
  });

  it("is none for another path, a missing path and without icons (the feature off)", async () => {
    await act(async () => root.render(<Probe path="/vault/Notes/Idea.md" />));
    expect(text()).toBe("none");
    setFileIcons([{ path: "Notes/Idea.md", icon: "emoji:🚀" }]);
    await act(async () => root.render(<Probe path="/vault/Other.md" />));
    expect(text()).toBe("none");
    await act(async () => root.render(<Probe path={null} />));
    expect(text()).toBe("none");
    await act(async () => root.render(<Probe path="/vault/Notes/Idea.md" />));
    expect(text()).toBe("emoji:🚀|");
    await act(async () => clearFileIcons());
    expect(text()).toBe("none");
  });

  it("re-renders when the icons change", async () => {
    setFileIcons([{ path: "a.md", icon: "emoji:🚀" }]);
    await act(async () => root.render(<Probe path="/vault/a.md" />));
    await act(async () => setFileIcons([{ path: "a.md", icon: "emoji:📚" }]));
    expect(text()).toBe("emoji:📚|");
  });
});

describe("links", () => {
  it("resolve the target with the vault resolver and answer the icon of the note it names", async () => {
    resolveWikiLinkTarget.mockResolvedValue("/vault/Notes/Idea.md");
    setFileIcons([{ path: "Notes/Idea.md", icon: "emoji:🚀" }]);
    await act(async () =>
      root.render(<LinkProbe target="Idea#Heading|alias" source="/vault/A.md" />),
    );
    expect(resolveWikiLinkTarget).toHaveBeenCalledWith("Idea", "/vault/A.md");
    expect(text()).toBe("emoji:🚀");
  });

  it("do not call the resolver while no icon exists", async () => {
    await act(async () => root.render(<LinkProbe target="Idea" />));
    expect(resolveWikiLinkTarget).not.toHaveBeenCalled();
    expect(text()).toBe("none");
  });

  it("a link to a heading of the same note and an unresolved link have none", async () => {
    setFileIcons([{ path: "a.md", icon: "emoji:🚀" }]);
    expect(await resolveLinkPath("#Heading", "/vault/a.md")).toBeNull();
    resolveWikiLinkTarget.mockResolvedValue(null);
    await act(async () => root.render(<LinkProbe target="Missing" />));
    expect(text()).toBe("none");
  });

  it("are cached for a few seconds: many links to one note cost one call", async () => {
    resolveWikiLinkTarget.mockResolvedValue("/vault/a.md");
    await Promise.all([resolveLinkPath("a", "/vault/x.md"), resolveLinkPath("a", "/vault/x.md")]);
    expect(resolveWikiLinkTarget).toHaveBeenCalledTimes(1);
  });

  it("a failing resolver is no icon, not an error", async () => {
    setFileIcons([{ path: "a.md", icon: "emoji:🚀" }]);
    resolveWikiLinkTarget.mockRejectedValue(new Error("down"));
    expect(await resolveLinkPath("a", null)).toBeNull();
  });
});

describe("watchLinkIcon (the DOM twin used by editor widgets)", () => {
  it("draws now and on every change, and stops when told to", async () => {
    resolveWikiLinkTarget.mockResolvedValue("/vault/a.md");
    const seen: (FileIconEntry | undefined)[] = [];
    setFileIcons([{ path: "a.md", icon: "emoji:🚀" }]);
    const stop = watchLinkIcon("a", null, (e) => seen.push(e));
    await vi.waitFor(() => expect(seen.at(-1)?.icon).toBe("emoji:🚀"));
    act(() => setFileIcons([{ path: "a.md", icon: "emoji:📚" }]));
    await vi.waitFor(() => expect(seen.at(-1)?.icon).toBe("emoji:📚"));
    act(() => clearFileIcons());
    await vi.waitFor(() => expect(seen.at(-1)).toBeUndefined());
    stop();
    const count = seen.length;
    act(() => setFileIcons([{ path: "a.md", icon: "emoji:🎯" }]));
    await Promise.resolve();
    expect(seen).toHaveLength(count);
  });
});

describe("fillIconElement", () => {
  it("draws an emoji as text, hides the element for none and keeps the colour", () => {
    const el = document.createElement("span");
    fillIconElement(el, "emoji:🚀", { color: "#112233" });
    expect(el.textContent).toBe("🚀");
    expect(el.style.display).toBe("inline-flex");
    expect(el.style.color).toBe("rgb(17, 34, 51)");
    fillIconElement(el, undefined);
    expect(el.textContent).toBe("");
    expect(el.style.display).toBe("none");
    fillIconElement(el, "rocket");
    expect(el.style.display).toBe("none");
  });

  it("draws a Hugeicons icon as an inline svg once its shard loads, and never over a newer value", async () => {
    const el = document.createElement("span");
    fillIconElement(el, "icon:Rocket01Icon", { size: 16 });
    await vi.waitFor(() => expect(el.querySelector("svg")).not.toBeNull());
    expect(el.querySelector("svg")!.getAttribute("width")).toBe("16");
    expect(el.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
    fillIconElement(el, "icon:Home01Icon");
    fillIconElement(el, "emoji:🚀");
    await new Promise((r) => setTimeout(r, 50));
    expect(el.querySelector("svg")).toBeNull();
    expect(el.textContent).toBe("🚀");
  });
});
