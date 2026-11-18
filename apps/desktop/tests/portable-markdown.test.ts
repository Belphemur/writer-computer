import { describe, expect, it } from "vite-plus/test";
import { toPortableMarkdown as p } from "@/lib/portable-markdown";

describe("toPortableMarkdown", () => {
  it("turns wiki links into their display text", () => {
    expect(p("[[Note]]")).toBe("Note");
    expect(p("see [[Note|Alias]] and [[folder/Note]]")).toBe("see Alias and Note");
    expect(p("[[Note#Heading]]")).toBe("Note > Heading");
    expect(p("[[#Heading]]")).toBe("Heading");
    expect(p("[[Note#^block]]")).toBe("Note");
    expect(p("[[Note.md]]")).toBe("Note");
  });

  it("removes embeds and tidies the whitespace", () => {
    expect(p("a ![[image.png]] b")).toBe("a b");
    expect(p("a ![[Note]]")).toBe("a");
    expect(p("![[x.png]] a")).toBe("a");
    expect(p("one\n\n![[x.png]]\n\ntwo")).toBe("one\n\ntwo");
    expect(p("one\n![[x.png]]\ntwo")).toBe("one\ntwo");
  });

  it("keeps external links and unwraps vault-relative ones", () => {
    expect(p("[a](https://x.dev/y) [b](mailto:a@b.c)")).toBe(
      "[a](https://x.dev/y) [b](mailto:a@b.c)",
    );
    expect(p("[text](note.md) [t](folder/x.md#h) [u](#h)")).toBe("text t u");
    expect(p("![alt](img.png)")).toBe("![alt](img.png)");
  });

  it("leaves code literal", () => {
    expect(p("use `[[Note]]` and [[Note]]")).toBe("use `[[Note]]` and Note");
    expect(p("```md\n[[Note]]\n![[x.png]]\n```\n[[Note]]")).toBe(
      "```md\n[[Note]]\n![[x.png]]\n```\nNote",
    );
  });

  it("is idempotent on plain text", () => {
    expect(p("plain **text**\n\n- a\n- b")).toBe("plain **text**\n\n- a\n- b");
  });
});
