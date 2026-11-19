// The shared takeover prompt: asks once, only while the plugin runs and core can control it, and
// turns the plugin off only on yes.
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  setCommunityPluginControl,
  setRunningCommunityPlugins,
  subscribeCommunityPlugins,
} from "./community-plugins";
import { offerPluginTakeover } from "./plugin-takeover";

afterEach(() => {
  setRunningCommunityPlugins([]);
  setCommunityPluginControl(null);
});

const confirmAction = vi.hoisted(() => vi.fn(async () => true));
vi.mock("./tauri", () => ({ confirmAction }));

function setup(yes = true, setEnabled = vi.fn(async () => {})) {
  localStorage.clear();
  confirmAction.mockClear();
  confirmAction.mockImplementation(async () => yes);
  setRunningCommunityPlugins(["p"]);
  setCommunityPluginControl({ setEnabled });
  const offer = { pluginId: "p", askedKey: "asked-p", message: "Turn off?", title: "Plugin P" };
  return { offer, setEnabled };
}

describe("offerPluginTakeover", () => {
  it("asks once, remembers, and turns the plugin off on yes", async () => {
    const { offer, setEnabled } = setup();
    expect(await offerPluginTakeover(offer)).toBe(true);
    expect(setEnabled).toHaveBeenCalledWith("p", false);
    expect(await offerPluginTakeover(offer)).toBe(false);
    expect(confirmAction).toHaveBeenCalledTimes(1);
  });

  it("leaves the plugin on for no, and does not ask again", async () => {
    const { offer, setEnabled } = setup(false);
    expect(await offerPluginTakeover(offer)).toBe(false);
    expect(setEnabled).not.toHaveBeenCalled();
    expect(await offerPluginTakeover(offer)).toBe(false);
    expect(confirmAction).toHaveBeenCalledTimes(1);
  });

  it("does nothing without the plugin or without control, and not twice at once", async () => {
    const { offer } = setup();
    setRunningCommunityPlugins([]);
    expect(await offerPluginTakeover(offer)).toBe(false);
    setRunningCommunityPlugins(["p"]);
    setCommunityPluginControl(null);
    expect(await offerPluginTakeover(offer)).toBe(false);
    setCommunityPluginControl({ setEnabled: async () => {} });
    const results = await Promise.all([offerPluginTakeover(offer), offerPluginTakeover(offer)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(confirmAction).toHaveBeenCalledTimes(1);
  });

  it("reports a plugin that could not be turned off", async () => {
    const { offer } = setup(
      true,
      vi.fn(async () => {
        throw new Error("no");
      }),
    );
    expect(await offerPluginTakeover(offer)).toBe(false);
  });
});

describe("subscribeCommunityPlugins", () => {
  it("notifies on set and control changes until unsubscribed", () => {
    const fn = vi.fn();
    const off = subscribeCommunityPlugins(fn);
    setRunningCommunityPlugins(["x"]);
    setCommunityPluginControl(null);
    expect(fn).toHaveBeenCalledTimes(2);
    off();
    setRunningCommunityPlugins([]);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
