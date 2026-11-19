// The shared takeover prompt: asks once, only while the plugin runs and core can control it, and
// turns the plugin off only when the answer says so.
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  setCommunityPluginControl,
  setRunningCommunityPlugins,
  subscribeCommunityPlugins,
} from "./community-plugins";
import { offerTakeover } from "./plugin-takeover";

afterEach(() => {
  setRunningCommunityPlugins([]);
  setCommunityPluginControl(null);
});

function setup(answer = "writer", setEnabled = vi.fn(async () => {})) {
  setRunningCommunityPlugins(["p"]);
  setCommunityPluginControl({ setEnabled });
  let stored: string | null = null;
  const ask = vi.fn(async () => answer);
  const offer = {
    pluginId: "p",
    scope: "test",
    remembered: () => stored,
    remember: (a: string) => void (stored = a),
    ask,
    turnsPluginOff: (a: string) => a === "writer",
  };
  return { offer, ask, setEnabled };
}

describe("offerTakeover", () => {
  it("asks once, remembers, and turns the plugin off on the matching answer", async () => {
    const { offer, ask, setEnabled } = setup();
    expect(await offerTakeover(offer)).toEqual({ answer: "writer", pluginOff: true });
    expect(setEnabled).toHaveBeenCalledWith("p", false);
    expect(await offerTakeover(offer)).toBeNull();
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("leaves the plugin on for another answer", async () => {
    const { offer, setEnabled } = setup("both");
    expect(await offerTakeover(offer)).toEqual({ answer: "both", pluginOff: false });
    expect(setEnabled).not.toHaveBeenCalled();
  });

  it("does nothing without the plugin or without control, and not twice at once", async () => {
    const { offer, ask } = setup();
    setRunningCommunityPlugins([]);
    expect(await offerTakeover(offer)).toBeNull();
    setRunningCommunityPlugins(["p"]);
    setCommunityPluginControl(null);
    expect(await offerTakeover(offer)).toBeNull();
    setCommunityPluginControl({ setEnabled: async () => {} });
    const [a, b] = await Promise.all([offerTakeover(offer), offerTakeover(offer)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("reports a plugin that could not be turned off", async () => {
    const { offer } = setup(
      "writer",
      vi.fn(async () => {
        throw new Error("no");
      }),
    );
    expect(await offerTakeover(offer)).toEqual({ answer: "writer", pluginOff: false });
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
