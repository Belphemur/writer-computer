import { describe, expect, it, vi } from "vite-plus/test";
import { logger } from "../src/lib/logger";
import {
  MIN_WEBKITGTK,
  oldWebviewMessage,
  webviewSupportsStyles,
} from "../src/lib/webview-support";

vi.mock("../src/lib/logger", () => ({ logger: { error: vi.fn() } }));

/** A fake `CSS`: every feature is there unless named; registerProperty is a function unless dropped. */
const css = (opts: { unsupported?: string[]; registerProperty?: boolean } = {}) => ({
  supports: (...args: string[]) =>
    !(opts.unsupported ?? []).some((u) => args.join(" ").includes(u)),
  ...(opts.registerProperty === false ? {} : { registerProperty: () => {} }),
});

describe("webview support", () => {
  it("accepts color-mix and registerProperty without CSS nesting (the build flattens it)", () => {
    const noNesting = css({ unsupported: ["selector(&)"] });
    expect(webviewSupportsStyles(noNesting)).toBe(true);
    expect(oldWebviewMessage("linux", noNesting)).toBeNull();
  });

  it("refuses one without color-mix or without registerProperty", () => {
    expect(webviewSupportsStyles(css({ unsupported: ["color-mix"] }))).toBe(false);
    expect(webviewSupportsStyles(css({ registerProperty: false }))).toBe(false);
  });

  it("logs the refusal", () => {
    oldWebviewMessage("linux", css({ registerProperty: false }));
    expect(logger.error).toHaveBeenCalled();
  });

  it("the Linux message names the minimum WebKitGTK and the package", () => {
    const message = oldWebviewMessage("linux", css({ unsupported: ["color-mix"] }))!;
    expect(MIN_WEBKITGTK).toBe("2.40");
    expect(message).toContain("WebKitGTK 2.40");
    expect(message).toContain("webkit2gtk-4.1");
  });

  it("other platforms get the generic message", () => {
    expect(oldWebviewMessage("windows", css({ unsupported: ["color-mix"] }))).toContain(
      "system web view",
    );
  });

  it("a runtime without CSS.supports is not warned about", () => {
    expect(webviewSupportsStyles({} as never)).toBe(true);
    expect(webviewSupportsStyles(undefined)).toBe(true);
  });
});
