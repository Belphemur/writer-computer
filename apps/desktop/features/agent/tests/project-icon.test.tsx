// @vitest-environment jsdom
// Project icon and color (spec 4.8): the search over Hugeicons names, the picker (virtualized grid,
// keyboard, swatches, reset), the write through the one IPC, `ProjectIcon`'s fallbacks and the
// rule that the full icon set is its own chunk.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({ get: async () => undefined, set: async () => {} })),
}));

// A small stand-in for the 4,000 icons: five real names and 400 fillers, in two shards.
vi.mock("@features/agent/web/lib/project-icon-shards", () => {
  const glyph = (id: string) => [["path", { d: `M0 0h${id.length}`, key: id }]];
  const names = [
    "Rocket01Icon",
    "RocketLaunchIcon",
    "ArrowDown01Icon",
    "ArrowUp01Icon",
    "Home01Icon",
    ...Array.from({ length: 400 }, (_, i) => `Filler${String(i).padStart(3, "0")}Icon`),
  ];
  const shard = (letter: string) =>
    Object.fromEntries(names.filter((n) => n[0] === letter).map((n) => [n, glyph(n)]));
  const letters = ["A", "F", "H", "R"];
  return {
    SHARD_LETTERS: letters,
    shardOf: (n: string) => (letters.includes(n.charAt(0)) ? n.charAt(0) : null),
    loadShard: async (l: string) => shard(l),
  };
});

import { DESKTOP, importsOf, sourceFiles, staticGraph } from "@tests/helpers/import-graph";
import { ProjectIcon } from "@features/agent/web/components/project-icon";
import {
  ProjectIconPicker,
  ProjectIconPopover,
} from "@features/agent/web/components/project-icon-picker";
import { projectClient, type ProjectDetail } from "@features/agent/web/lib/project-client";
import {
  DEFAULT_PROJECT_ICON,
  PROJECT_COLORS,
  loadProjectIconSet,
  resetProjectIconSetForTests,
} from "@features/agent/web/lib/project-appearance";
import {
  buildIconIndex,
  iconWords,
  searchIconIndex,
} from "@features/agent/web/lib/project-icon-search";
import { useProjectsStore } from "@features/agent/web/stores/projects-store";
import { useWorkspaceStore } from "@/stores/workspace-store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

for (const name of ["offsetHeight", "clientHeight"])
  Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => 216 });
for (const name of ["offsetWidth", "clientWidth"])
  Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => 316 });

let container: HTMLElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  resetProjectIconSetForTests();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const render = async (node: React.ReactNode) => {
  await act(async () => root.render(node));
  await flush();
};
const options = () => [...container.querySelectorAll<HTMLElement>("[role=option]")];
const search = () => container.querySelector<HTMLInputElement>("input[aria-label='Search icons']")!;
function type(text: string) {
  const input = search();
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  return act(async () => {
    set.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const key = (k: string) =>
  act(async () => {
    search().dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
  });
const click = (el: Element) => act(async () => (el as HTMLElement).click());
const mouseDown = (el: Element) =>
  act(async () => {
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  });

describe("icon search", () => {
  it("splits an export name into words", () => {
    expect(iconWords("Rocket01Icon")).toEqual(["rocket", "01"]);
    expect(iconWords("ArrowDown01Icon")).toEqual(["arrow", "down", "01"]);
    expect(iconWords("AiBrain02Icon")).toEqual(["ai", "brain", "02"]);
    expect(iconWords("Cursor3DIcon")).toEqual(["cursor", "3", "d"]);
  });

  const index = buildIconIndex([
    "Rocket01Icon",
    "RocketLaunchIcon",
    "ArrowDown01Icon",
    "Home01Icon",
  ]);

  it("matches every query word by prefix, whole words and shorter names first", () => {
    expect(searchIconIndex(index, "rocket").map((e) => e.name)).toEqual([
      "Rocket01Icon",
      "RocketLaunchIcon",
    ]);
    expect(searchIconIndex(index, "roc lau").map((e) => e.name)).toEqual(["RocketLaunchIcon"]);
    expect(searchIconIndex(index, "arrow down").map((e) => e.name)).toEqual(["ArrowDown01Icon"]);
    // fewer words rank first
    expect(searchIconIndex(index, "01").map((e) => e.name)).toEqual([
      "Home01Icon",
      "Rocket01Icon",
      "ArrowDown01Icon",
    ]);
    expect(searchIconIndex(index, "zzz")).toEqual([]);
    expect(searchIconIndex(index, "  ")).toHaveLength(4);
  });
});

describe("the picker", () => {
  const value = { icon: "Home01Icon", color: "blue" };

  it("virtualizes the grid and searches the loaded set", async () => {
    await render(<ProjectIconPicker value={value} onChange={() => {}} onClose={() => {}} />);
    const first = options().length;
    expect(first).toBeGreaterThan(8);
    expect(first).toBeLessThan(100); // 405 icons, only a window of them in the DOM
    expect(search().placeholder).toBe("Search 405 icons");
    await type("rocket");
    expect(options().map((o) => o.dataset.iconName)).toEqual(["Rocket01Icon", "RocketLaunchIcon"]);
    await type("nothing like it");
    expect(container.textContent).toContain("No matching icon");
  });

  it("moves with the arrows, picks with Enter and keeps the current color", async () => {
    const onChange = vi.fn();
    await render(<ProjectIconPicker value={value} onChange={onChange} onClose={() => {}} />);
    await type("a"); // Filler..., Arrow..., all names with a word starting with a
    const names = options().map((o) => o.dataset.iconName);
    expect(search().getAttribute("aria-activedescendant")).toContain(names[0]!);
    await key("ArrowRight");
    await key("Enter");
    expect(onChange).toHaveBeenLastCalledWith({ icon: names[1], color: "blue" }, "icon");
    await type("arrow");
    await key("ArrowLeft"); // stays on the first
    await key("Enter");
    expect(onChange).toHaveBeenLastCalledWith({ icon: "ArrowDown01Icon", color: "blue" }, "icon");
  });

  it("moves a row at a time with ArrowDown and a click picks too", async () => {
    const onChange = vi.fn();
    await render(<ProjectIconPicker value={value} onChange={onChange} onClose={() => {}} />);
    await key("ArrowDown");
    await key("Enter");
    const all = buildIconIndex(Object.keys(await loadProjectIconSet()));
    expect(onChange).toHaveBeenLastCalledWith({ icon: all[8]!.name, color: "blue" }, "icon");
    await mouseDown(options()[2]!);
    expect(onChange).toHaveBeenLastCalledWith({ icon: all[2]!.name, color: "blue" }, "icon");
  });

  it("Escape closes, a swatch picks a color and Reset clears both", async () => {
    const onChange = vi.fn();
    const onClose = vi.fn();
    await render(<ProjectIconPicker value={value} onChange={onChange} onClose={onClose} />);
    await key("Escape");
    expect(onClose).toHaveBeenCalledOnce();
    const swatches = [
      ...container.querySelectorAll<HTMLElement>("[aria-label=Color] button[title]"),
    ];
    expect(swatches.map((s) => s.title)).toEqual([...PROJECT_COLORS]);
    expect(swatches.find((s) => s.title === "blue")!.getAttribute("aria-pressed")).toBe("true");
    await click(swatches.find((s) => s.title === "pink")!);
    expect(onChange).toHaveBeenLastCalledWith({ icon: "Home01Icon", color: "pink" }, "color");
    await click([...container.querySelectorAll("button")].find((b) => b.textContent === "Reset")!);
    expect(onChange).toHaveBeenLastCalledWith({ icon: null, color: null }, "reset");
  });
});

describe("saving from the popover", () => {
  const stored = (over: Partial<ProjectDetail> = {}) =>
    ({ path: "Projects/Acme", name: "Acme", icon: null, color: null, ...over }) as ProjectDetail;

  beforeEach(() => {
    useWorkspaceStore.setState({ root: "/v" });
    useProjectsStore.setState({
      projects: [stored()],
      folderPaths: new Map([["/v/Projects/Acme", { icon: null, color: null }]]),
    });
  });

  const mount = (onClose: () => void) => {
    const anchor = { current: document.body };
    return render(
      <ProjectIconPopover projectPath="Projects/Acme" anchorRef={anchor} onClose={onClose} />,
    );
  };

  it("writes an icon through project update, refreshes the badge map and closes", async () => {
    const update = vi
      .spyOn(projectClient, "update")
      .mockResolvedValue(stored({ icon: "Rocket01Icon", color: null }));
    const onClose = vi.fn();
    await mount(onClose);
    await type("rocket");
    await mouseDown(options()[0]!);
    await flush();
    expect(update).toHaveBeenCalledExactlyOnceWith("Projects/Acme", {
      icon: "Rocket01Icon",
      color: "",
    });
    expect(useProjectsStore.getState().folderPaths.get("/v/Projects/Acme")).toEqual({
      icon: "Rocket01Icon",
      color: null,
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("a color write stays open; Reset removes both keys", async () => {
    const update = vi.spyOn(projectClient, "update").mockResolvedValue(stored({ color: "teal" }));
    const onClose = vi.fn();
    await mount(onClose);
    await click(container.querySelector("button[title=teal]")!);
    expect(update).toHaveBeenLastCalledWith("Projects/Acme", { icon: "", color: "teal" });
    expect(onClose).not.toHaveBeenCalled();
    update.mockResolvedValue(stored());
    await click([...container.querySelectorAll("button")].find((b) => b.textContent === "Reset")!);
    expect(update).toHaveBeenLastCalledWith("Projects/Acme", { icon: "", color: "" });
    expect(onClose).toHaveBeenCalled();
  });

  it("shows the backend's refusal and stays open", async () => {
    vi.spyOn(projectClient, "update").mockRejectedValue(new Error("not a project color"));
    const onClose = vi.fn();
    await mount(onClose);
    await click(container.querySelector("button[title=red]")!);
    expect(container.querySelector("[role=alert]")?.textContent).toBe("not a project color");
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("ProjectIcon", () => {
  const glyph = (html: string) => container.querySelector("svg")!.innerHTML + html;

  it("falls back to the default icon and the accent for nothing or an unknown name", async () => {
    await render(<ProjectIcon />);
    const dflt = glyph("");
    const span = container.querySelector<HTMLElement>("[data-project-icon]")!;
    expect(span.style.color).toBe("var(--accent)");
    expect(dflt.length).toBeGreaterThan(0);
    await render(<ProjectIcon icon="NoSuchIcon" color="chartreuse" />);
    expect(glyph("")).toBe(dflt);
    expect(container.querySelector<HTMLElement>("[data-project-icon]")!.style.color).toBe(
      "var(--accent)",
    );
    expect(DEFAULT_PROJECT_ICON).toBeTruthy();
  });

  it("draws a known icon in its color once the set has loaded", async () => {
    await render(<ProjectIcon />);
    const dflt = container.querySelector("svg")!.innerHTML;
    await render(<ProjectIcon icon="Rocket01Icon" color="blue" />);
    await flush();
    expect(container.querySelector("svg")!.innerHTML).not.toBe(dflt);
    expect(container.querySelector<HTMLElement>("[data-project-icon]")!.style.color).toBe(
      "var(--project-color-blue)",
    );
  });
});

describe("the icon set is lazy", () => {
  const rel = (f: string) => relative(DESKTOP, f);

  it("only the shard registry reaches the shard modules, and only dynamically", () => {
    const offenders: string[] = [];
    for (const dir of ["src", "features"])
      for (const f of sourceFiles(join(DESKTOP, dir)))
        for (const i of importsOf(f))
          if (/icon-shards\/[A-Z]$/.test(i.spec) && !i.typeOnly) offenders.push(rel(f));
    expect(offenders).toEqual([]);
  });

  it("the feature's startup graph holds the light helpers, not the picker, the search or a shard", () => {
    const reached = [...staticGraph(join(DESKTOP, "features/agent/web/index.ts"))].map(rel);
    expect(reached).toContain("features/agent/web/lib/project-appearance.ts");
    expect(
      reached.filter((f) => /icon-shards\/|project-icon-picker|project-icon-search/.test(f)),
    ).toEqual([]);
  });

  it("in the built app the entry holds no icon, one icon loads one letter's chunk, the picker all", () => {
    const out = mkdtempSync(join(tmpdir(), "icons-build-"));
    try {
      execFileSync("pnpm", ["exec", "vp", "build", "--outDir", out], {
        cwd: DESKTOP,
        stdio: "pipe",
        timeout: 150_000,
      });
      const assets = readdirSync(join(out, "assets")).filter((f) => f.endsWith(".js"));
      const code = (f: string) => readFileSync(join(out, "assets", f), "utf8");
      const size = (f: string) => statSync(join(out, "assets", f)).size;
      const holding = (name: string) =>
        assets.filter((f) => code(f).includes(`"${name}"`) || code(f).includes(name));
      // Drawing Rocket01Icon needs exactly one chunk, and not the whole set.
      const holders = holding("Rocket01Icon");
      expect(holders).toHaveLength(1);
      expect(holders[0]).not.toMatch(/^index-/);
      expect(code(holders[0]!)).not.toContain("Airplane01Icon");
      // The entry (and its preload map) names no icon at all.
      for (const f of assets.filter((f) => f.startsWith("index-"))) {
        expect(code(f)).not.toContain("Rocket01Icon");
        expect(code(f)).not.toContain("Robot01Icon");
      }
      // The whole set is the letter chunks together: a few dozen files, not thousands.
      const shards = assets.filter((f) => /^[A-Z]-/.test(f));
      const total = shards.reduce((n, f) => n + size(f), 0);
      console.info(
        `icon shards: ${shards.length} chunks, ${(total / 1e6).toFixed(1)} MB in all, the one for Rocket01Icon ${(size(holders[0]!) / 1e3).toFixed(0)} kB; ${assets.length} JS files in the bundle`,
      );
      expect(shards.length).toBeLessThanOrEqual(26);
      expect(size(holders[0]!)).toBeLessThan(total / 8);
      expect(assets.length).toBeLessThan(600);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 180_000);
});
