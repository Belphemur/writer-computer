// @vitest-environment jsdom
// A setting with a `platform` is listed as a row only where it applies: `appliesHere` is the one
// predicate, used by the settings blocks, the generated feature pages and the theme primaries.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/components/settings-panel/setting-rows", () => ({
  SettingRows: ({ defs }: { defs: { key: string }[] }) => (
    <ul>
      {defs.map((d) => (
        <li key={d.key} data-key={d.key} />
      ))}
    </ul>
  ),
}));

import { CategoryBlock } from "@/components/settings-panel/settings-blocks";
import { appliesHere, getPrimaryDefs } from "@/lib/settings-schema";

const UA = {
  linux: "Mozilla/5.0 (X11; Linux x86_64)",
  macos: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
  windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
};

describe("appliesHere", () => {
  it("lists a setting without a platform everywhere", () => {
    for (const p of ["macos", "linux", "windows"] as const) expect(appliesHere({}, p)).toBe(true);
  });

  it("macos means macOS; linux means every other OS, Windows included", () => {
    expect(appliesHere({ platform: "macos" }, "macos")).toBe(true);
    expect(appliesHere({ platform: "macos" }, "linux")).toBe(false);
    expect(appliesHere({ platform: "macos" }, "windows")).toBe(false);
    expect(appliesHere({ platform: "linux" }, "linux")).toBe(true);
    expect(appliesHere({ platform: "linux" }, "windows")).toBe(true);
    expect(appliesHere({ platform: "linux" }, "macos")).toBe(false);
  });

  it("the translucent sliders are macOS-only, so Linux has no inline --bg-opacity", () => {
    const keys = (p: "macos" | "linux") => getPrimaryDefs("dark", p).map((d) => d.key);
    expect(keys("macos")).toContain("theme.dark.translucent");
    expect(keys("linux")).not.toContain("theme.dark.translucent");
  });
});

describe("the settings rows", () => {
  let container: HTMLElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  const rows = async (platform: keyof typeof UA) => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(UA[platform]);
    await act(async () =>
      root.render(<CategoryBlock block={{ type: "category", category: "Appearance" }} hideTitle />),
    );
    return [...container.querySelectorAll("li")].map((li) => li.getAttribute("data-key"));
  };

  it("shows the native-frame row on Linux only", async () => {
    expect(await rows("linux")).toContain("appearance.native-decorations");
    expect(await rows("macos")).not.toContain("appearance.native-decorations");
  });
});
