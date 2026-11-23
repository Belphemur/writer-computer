import { describe, expect, it } from "vite-plus/test";
import {
  MIN_WEBKITGTK,
  oldWebviewMessage,
  webviewSupportsStyles,
} from "../src/lib/webview-support";

const css = (...unsupported: string[]) => ({
  supports: (...args: string[]) => !unsupported.some((u) => args.join(" ").includes(u)),
});

describe("webview support", () => {
  it("accepts a web view with CSS nesting and color-mix", () => {
    expect(webviewSupportsStyles(css())).toBe(true);
    expect(oldWebviewMessage("linux", css())).toBeNull();
  });

  it("refuses one without color-mix or without nesting", () => {
    expect(webviewSupportsStyles(css("color-mix"))).toBe(false);
    expect(webviewSupportsStyles(css("selector(&)"))).toBe(false);
  });

  it("the Linux message names the minimum WebKitGTK and the package", () => {
    const message = oldWebviewMessage("linux", css("color-mix"))!;
    expect(MIN_WEBKITGTK).toBe("2.44");
    expect(message).toContain("WebKitGTK 2.44");
    expect(message).toContain("webkit2gtk-4.1");
  });

  it("other platforms get the generic message", () => {
    expect(oldWebviewMessage("windows", css("color-mix"))).toContain("system web view");
  });

  it("a runtime without CSS.supports is not warned about", () => {
    expect(webviewSupportsStyles({} as never)).toBe(true);
    expect(webviewSupportsStyles(undefined)).toBe(true);
  });
});
