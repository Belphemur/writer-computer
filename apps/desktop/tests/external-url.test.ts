import external from "@shared/external-protocols.json";
import { describe, expect, it } from "vite-plus/test";
import {
  DOC_LINK_ABSOLUTE,
  EXTERNAL_PROTOCOLS,
  externalOrAnchorUriRegExp,
  isExternalHref,
} from "@/lib/external-url";

describe("external URL allowlist", () => {
  it("is http, https and mailto", () => {
    expect([...EXTERNAL_PROTOCOLS].sort()).toEqual(["http:", "https:", "mailto:"]);
  });

  it("isExternalHref checks the scheme the href starts with, case-insensitively", () => {
    for (const ok of ["https://a.test", "HTTP://a.test", "mailto:a@b.test"])
      expect(isExternalHref(ok), ok).toBe(true);
    for (const no of [
      "tel:123",
      "javascript:x",
      "file:///a",
      "obsidian://open",
      "a/b.md",
      "",
      null,
    ])
      expect(isExternalHref(no), String(no)).toBe(false);
  });

  it("the sanitiser regexp admits the same schemes plus #anchors", () => {
    const re = externalOrAnchorUriRegExp();
    expect(["https://a", "mailto:a@b", "#wikilink:x"].every((u) => re.test(u))).toBe(true);
    expect(["tel:1", "javascript:x", "data:text/html,x"].some((u) => re.test(u))).toBe(false);
  });

  it("demands // after http and https, as the Rust gate does", () => {
    for (const no of ["http:foo", "https:/x", "https:x"])
      expect(isExternalHref(no), no).toBe(false);
    expect(isExternalHref("mailto:a@b")).toBe(true);
    expect(isExternalHref("https://a.test")).toBe(true);
  });

  it("is built from the shared list the Rust gate reads", () => {
    expect([...EXTERNAL_PROTOCOLS]).toEqual(external.schemes.map((s) => `${s.scheme}:`));
  });

  it("plugin-rendered docs admit the shared list plus the named extras (tel)", () => {
    for (const ok of ["https://a", "mailto:a@b", "TEL:+1555"])
      expect(DOC_LINK_ABSOLUTE.test(ok)).toBe(true);
    for (const no of ["javascript:x", "file:///a", "data:text/html,x"])
      expect(DOC_LINK_ABSOLUTE.test(no)).toBe(false);
  });
});
