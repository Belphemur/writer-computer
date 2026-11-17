import { describe, expect, test, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

describe("attachment IPC", () => {
  test("bytes travel as the raw body, the note and name in a base64 header", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockResolvedValue({ relative_path: "attachments/é.png" });
    const { saveAttachment } = await import("../src/lib/tauri");
    const bytes = new Uint8Array([1, 2, 3]);
    await saveAttachment("/ws/né.md", "é.png", bytes);

    const [command, body, options] = vi.mocked(invoke).mock.calls.at(-1)!;
    expect(command).toBe("save_attachment");
    expect(body).toBe(bytes);
    const header = (options as { headers: Record<string, string> }).headers["x-writer-meta"];
    const decoded = JSON.parse(
      new TextDecoder().decode(Uint8Array.from(atob(header), (c) => c.charCodeAt(0))),
    );
    expect(decoded).toEqual({ note_path: "/ws/né.md", name: "é.png" });
  });

  test("a dropped file is copied by path", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const { importAttachmentFile } = await import("../src/lib/tauri");
    await importAttachmentFile("/ws/a.md", "/Users/me/Desktop/x.png");
    expect(invoke).toHaveBeenLastCalledWith("import_attachment_file", {
      notePath: "/ws/a.md",
      sourcePath: "/Users/me/Desktop/x.png",
    });
  });

  test("a remote image is downloaded by URL in Rust", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const { importAttachmentUrl } = await import("../src/lib/tauri");
    await importAttachmentUrl("/ws/a.md", "https://x.test/a.png", "Pasted image 1");
    expect(invoke).toHaveBeenLastCalledWith("import_attachment_url", {
      notePath: "/ws/a.md",
      url: "https://x.test/a.png",
      fallbackStem: "Pasted image 1",
    });
  });
});
