// @vitest-environment jsdom
import { describe, expect, test } from "vite-plus/test";
import { README_MAX_CHARS, renderReadme } from "../web/plugin-browser/render-readme";
import { classifyLink } from "../web/plugin-browser/link-action";

const dom = (html: string) => {
  const t = document.createElement("template");
  t.innerHTML = html;
  return t.content;
};

describe("renderReadme", () => {
  test("markdown becomes HTML", () => {
    const html = renderReadme(
      "# Title\n\nSome **bold** and `code`.\n\n- a\n- b\n\n| x | y |\n|---|---|\n| 1 | 2 |",
    );
    const d = dom(html);
    expect(d.querySelector("h1")?.textContent).toBe("Title");
    expect(d.querySelector("strong")?.textContent).toBe("bold");
    expect(d.querySelectorAll("li")).toHaveLength(2);
    expect(d.querySelector("table td")?.textContent).toBe("1");
    expect(html).not.toContain("# Title");
  });

  test("task lists have no inputs", () => {
    const html = renderReadme("- [x] done\n- [ ] todo");
    expect(html).not.toContain("<input");
    expect(html).toContain("☑");
    expect(html).toContain("☐");
  });

  test("raw HTML README is handled by the same pipeline", () => {
    const d = dom(renderReadme('<h2 align="center">Hi</h2><p>text</p>'));
    expect(d.querySelector("h2")?.getAttribute("align")).toBe("center");
  });

  test("strips scripts, handlers, iframes, styles, forms and svg", () => {
    const evil = [
      "<script>alert(1)</script>",
      '<img src="https://x.test/a.png" onerror="alert(1)">',
      '<a href="https://x.test" onclick="alert(1)" style="color:red">l</a>',
      '<iframe src="https://evil.test"></iframe>',
      "<style>body{display:none}</style>",
      '<p style="position:fixed">p</p>',
      '<form action="https://evil.test"><input name="a"><button>go</button></form>',
      "<svg onload=alert(1)><script>1</script></svg>",
      '<object data="x"></object><embed src="x">',
      '<div id="plugin-detail-title" class="x" data-a="1">d</div>',
    ].join("\n\n");
    const html = renderReadme(evil);
    const d = dom(html);
    for (const sel of [
      "script",
      "iframe",
      "style",
      "form",
      "input",
      "svg",
      "object",
      "embed",
      "button",
    ]) {
      expect(d.querySelector(sel), sel).toBeNull();
    }
    expect(html).not.toMatch(/onerror|onclick|onload|style=|alert\(1\)|id="plugin|class=|data-a/i);
  });

  test("javascript:, data: and other schemes are removed from links and images", () => {
    const html = renderReadme(
      [
        "[a](javascript:alert(1))",
        "[b](JaVaScRiPt:alert(1))",
        "[c](data:text/html;base64,AAAA)",
        "[d](file:///etc/passwd)",
        "![e](data:image/png;base64,AAAA)",
        '<a href="  javascript:alert(1)">f</a>',
        '<img src="javascript:alert(1)">',
      ].join("\n\n"),
    );
    const d = dom(html);
    for (const a of Array.from(d.querySelectorAll("a"))) expect(a.hasAttribute("href")).toBe(false);
    for (const i of Array.from(d.querySelectorAll("img")))
      expect(i.hasAttribute("src")).toBe(false);
  });

  test("links get target and rel; http(s), mailto kept", () => {
    const d = dom(renderReadme("[w](https://example.com) [m](mailto:a@b.co)"));
    const [w, m] = Array.from(d.querySelectorAll("a"));
    expect(w.getAttribute("href")).toBe("https://example.com");
    expect(w.getAttribute("target")).toBe("_blank");
    expect(w.getAttribute("rel")).toContain("noopener");
    expect(m.getAttribute("href")).toBe("mailto:a@b.co");
  });

  test("relative URLs resolve against the GitHub repo", () => {
    const d = dom(
      renderReadme("![s](docs/shot.png) ![r](/img/a.png) [g](docs/guide.md) [top](#usage)", {
        repo: "owner/name",
      }),
    );
    const imgs = Array.from(d.querySelectorAll("img"));
    expect(imgs[0].getAttribute("src")).toBe(
      "https://raw.githubusercontent.com/owner/name/HEAD/docs/shot.png",
    );
    expect(imgs[1].getAttribute("src")).toBe(
      "https://raw.githubusercontent.com/owner/name/HEAD/img/a.png",
    );
    const links = Array.from(d.querySelectorAll("a"));
    expect(links[0].getAttribute("href")).toBe(
      "https://github.com/owner/name/blob/HEAD/docs/guide.md",
    );
    expect(links[1].getAttribute("href")).toBe("#usage");
  });

  test("relative URLs are dropped without a repo, and cannot escape it", () => {
    const none = dom(renderReadme("![s](docs/shot.png)"));
    expect(none.querySelector("img")?.hasAttribute("src")).toBe(false);
    const up = dom(
      renderReadme("![s](../../other/repo/x.png) ![p](//evil.test/x.png)", { repo: "o/n" }),
    );
    for (const i of Array.from(up.querySelectorAll("img"))) {
      expect(i.getAttribute("src") ?? "").not.toContain("evil.test");
      expect(i.getAttribute("src") ?? "").not.toContain("other/repo");
    }
  });

  test("headings get readme- prefixed ids for in-pane anchors", () => {
    const d = dom(renderReadme("## Getting Started"));
    expect(d.querySelector("h2")?.id).toBe("readme-getting-started");
  });

  test("huge input is truncated with a note", () => {
    const html = renderReadme("word ".repeat(README_MAX_CHARS / 4));
    expect(html).toContain("README truncated");
    expect(html.length).toBeLessThan(README_MAX_CHARS * 1.1);
    expect(renderReadme("small")).not.toContain("truncated");
  });
});

describe("classifyLink", () => {
  test("http(s)/mailto open, anchors scroll, everything else is ignored", () => {
    expect(classifyLink("https://a.test")).toEqual({ kind: "open", url: "https://a.test" });
    expect(classifyLink("mailto:a@b.co").kind).toBe("open");
    expect(classifyLink("#my%20id")).toEqual({ kind: "anchor", id: "my id" });
    expect(classifyLink("#").kind).toBe("ignore");
    expect(classifyLink("docs/x.md").kind).toBe("ignore");
    expect(classifyLink("javascript:alert(1)").kind).toBe("ignore");
    expect(classifyLink(null).kind).toBe("ignore");
  });
});
