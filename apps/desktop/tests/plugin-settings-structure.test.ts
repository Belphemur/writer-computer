// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { mountSettingTab } from "../src/components/plugins/mount-setting-tab";
import { PluginSettingTab, Setting } from "../src/lib/obsidian-host/api/ui";
import type { App } from "../src/lib/obsidian-host/api/app";
import type { Plugin } from "../src/lib/obsidian-host/api/core";

/** Synthetic fixture tab: every control kind the plugin-settings stylesheet targets. */
class FixtureTab extends PluginSettingTab {
  displays = 0;
  display(): void {
    this.displays++;
    const el = this.containerEl;

    el.replaceChildren();
    new Setting(el).setName("Section A").setHeading();
    new Setting(el)
      .setName("Toggle")
      .setDesc("on or off")
      .addToggle((t) => t.setValue(true));
    new Setting(el)
      .setName("Pick")
      .addDropdown((d) => d.addOption("a", "A").addOption("b", "B").setValue("b"));
    new Setting(el).setName("Text").addText((t) => t.setValue("hi"));
    new Setting(el)
      .setName("Zoom")
      .addSlider((s) => s.setLimits(0, 10, 1).setValue(3).setDynamicTooltip());
    new Setting(el).setName("Section B").setHeading();
    new Setting(el).setName("Notes").addTextArea((t) => t.setValue("x"));
    new Setting(el).setName("Run").addButton((b) => b.setButtonText("Go").setCta());
    new Setting(el).setName("Reset").addExtraButton((b) => b.setIcon("rotate-ccw"));
  }
}

const fixture = (): FixtureTab =>
  new FixtureTab({} as App, { manifest: { id: "fx", name: "Fixture" } } as unknown as Plugin);

describe("plugin settings DOM structure", () => {
  it("emits the classes plugin-settings.css targets", () => {
    const host = document.createElement("div");
    mountSettingTab(host, "fx", fixture());
    const q = (s: string) => host.querySelectorAll(s).length;
    expect(host.querySelector(".vertical-tab-content")).not.toBeNull();
    expect(q(".setting-item")).toBe(9);
    expect(q(".setting-item-heading")).toBe(2);
    expect(q(".setting-item > .setting-item-info > .setting-item-name")).toBe(9);
    expect(q(".setting-item > .setting-item-control")).toBe(9);
    expect(host.querySelector(".checkbox-container.is-enabled")).not.toBeNull();
    expect(host.querySelector("select.dropdown")).not.toBeNull();
    expect(host.querySelector(".setting-item-control input[type=text]")).not.toBeNull();
    expect(host.querySelector(".setting-item-control input[type=range].slider")).not.toBeNull();
    expect(host.querySelector(".setting-item-control textarea")).not.toBeNull();
    expect(host.querySelector(".setting-item-control button.mod-cta")).not.toBeNull();
    expect(host.querySelector(".setting-item-control .clickable-icon")).not.toBeNull();
    // Headings break runs: rows of a card are consecutive non-heading siblings.
    const kids = [...host.querySelector(".vertical-tab-content")!.children];
    const runs: number[] = [];
    let run = 0;
    for (const k of kids) {
      if (k.classList.contains("setting-item-heading")) {
        if (run) runs.push(run);
        run = 0;
      } else run++;
    }
    runs.push(run);
    expect(runs).toEqual([4, 3]);
  });

  it("slider shows a value readout beside it that follows input and setValue", () => {
    const host = document.createElement("div");
    mountSettingTab(host, "fx", fixture());
    const slider = host.querySelector<HTMLInputElement>("input[type=range]")!;
    const readout = slider.nextElementSibling as HTMLElement;
    expect(readout.className).toBe("writer-slider-readout");
    expect(readout.textContent).toBe("3");
    slider.value = "7";
    slider.dispatchEvent(new Event("input"));
    expect(readout.textContent).toBe("7");
  });

  it("re-rendering via display() yields the same structure (grouping is CSS-only, no DOM pass)", () => {
    const host = document.createElement("div");
    const tab = fixture();
    mountSettingTab(host, "fx", tab);
    const before = host.innerHTML;
    tab.display();
    tab.display();
    expect(tab.displays).toBe(3);
    expect(host.querySelectorAll(".setting-item").length).toBe(9);
    expect(host.innerHTML).toBe(before);
    expect(host.querySelector(".setting-card")).toBeNull();
  });

  it("stylesheet keeps the run-grouping, stacked and toggle rules", () => {
    const css = readFileSync("src/components/settings-panel/plugin-settings.css", "utf8");
    for (const needle of [
      ":is(.plugin-settings, .modal-container)",
      ".setting-item:has(+ :is(:not(.setting-item), .setting-item-heading))",
      ".setting-item:has(.setting-item-control textarea)",
      ".checkbox-container.is-enabled",
      "var(--surface-card)",
      "var(--select-chevron)",
    ])
      expect(css).toContain(needle);
  });
});
