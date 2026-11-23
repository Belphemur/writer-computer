import { describe, expect, test } from "vite-plus/test";

import { detectDownloadOs } from "../src/download";

describe("detectDownloadOs", () => {
  test("a Linux desktop gets the Linux build", () => {
    expect(
      detectDownloadOs("Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0"),
    ).toBe("linux");
    expect(detectDownloadOs("Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/537.36")).toBe(
      "linux",
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
