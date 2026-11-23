import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vite-plus/test";

import { DownloadButton, OtherDownloads } from "../src/components/DownloadButton";
import { type DownloadOs, detectDownloadOs } from "../src/download";

describe("detectDownloadOs", () => {
  test("a Linux desktop gets the Linux build", () => {
    expect(
      detectDownloadOs("Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0"),
    ).toBe("linux");
    expect(detectDownloadOs("Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/537.36")).toBe(
      "linux",
    );
  });

  test("ChromeOS gets the .deb's own OS, and ARM machines are sent to the releases page", () => {
    expect(detectDownloadOs("Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36")).toBe(
      "chromeos",
    );
    expect(detectDownloadOs("Mozilla/5.0 (X11; CrOS aarch64 15662.76.0) AppleWebKit/537.36")).toBe(
      "other",
    );
    expect(detectDownloadOs("Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36")).toBe("other");
    expect(detectDownloadOs("Mozilla/5.0 (X11; Linux armv7l; rv:130.0) Gecko/20100101")).toBe(
      "other",
    );
  });

  test("a Mac, a phone or anything unknown gets the Mac build", () => {
    expect(
      detectDownloadOs("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15"),
    ).toBe("mac");
    expect(detectDownloadOs("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36")).toBe(
      "mac",
    );
    expect(detectDownloadOs("")).toBe("mac");
  });
});

describe("the download button", () => {
  const assets = {
    mac: "https://x/Writer.dmg",
    appimage: "https://x/Writer.AppImage",
    deb: "https://x/Writer.deb",
    rpm: "https://x/Writer.rpm",
    releases: "https://x/releases",
  };
  const render = (os: DownloadOs) =>
    renderToStaticMarkup(
      createElement(
        "div",
        null,
        createElement(DownloadButton, { os, assets, onDownload: () => {} }),
        createElement(OtherDownloads, { os, assets, onDownload: () => {} }),
      ),
    );
  const hrefs = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);

  test("on a Mac the button is the dmg and the Linux packages are the links", () => {
    const html = render("mac");
    expect(html).toContain("Download for macOS");
    expect(hrefs(html)).toEqual([assets.mac, assets.appimage, assets.deb, assets.rpm]);
  });

  test("on Linux the button is the AppImage and the rest are the links", () => {
    const html = render("linux");
    expect(html).toContain("Download for Linux");
    expect(hrefs(html)).toEqual([assets.appimage, assets.deb, assets.rpm, assets.mac]);
  });

  test("on ChromeOS the button is the .deb", () => {
    expect(hrefs(render("chromeos"))[0]).toBe(assets.deb);
  });

  test("a machine with no package gets the releases page and no links", () => {
    expect(hrefs(render("other"))).toEqual([assets.releases]);
  });
});
