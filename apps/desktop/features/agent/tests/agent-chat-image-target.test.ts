// The composer registers once and is found by both drops: Finder files through the OS drop
// dispatcher (`lib/os-drop`) and the sidebar's pointer drag through `lib/vault-drop-target.ts`.
import { describe, expect, it, vi } from "vite-plus/test";
import { createOsDropHandler } from "@/lib/os-drop";
import { dropVaultFilesOnTarget } from "@/lib/vault-drop-target";
import { registerChatImageTarget } from "@features/agent/web/lib/chat-image-target";

describe("chat image target", () => {
  it("takes vault files and folders from the sidebar drag and Finder paths from the OS drop", () => {
    const attach = vi.fn();
    const setOver = vi.fn();
    const off = registerChatImageTarget({ contains: (x) => x < 100, attach, setOver });
    expect(dropVaultFilesOnTarget(50, 0, [{ path: "Img/a.png", isDir: false }])).toBe(true);
    expect(attach).toHaveBeenLastCalledWith([{ kind: "vault", path: "Img/a.png", isDir: false }]);
    expect(dropVaultFilesOnTarget(50, 0, [{ path: "Img", isDir: true }])).toBe(true);
    expect(attach).toHaveBeenLastCalledWith([{ kind: "vault", path: "Img", isDir: true }]);

    const os = createOsDropHandler("macos");
    os({ type: "enter", paths: ["/tmp/x.png"], position: { x: 50, y: 0 } } as never);
    expect(setOver).toHaveBeenLastCalledWith(true);
    os({ type: "drop", paths: ["/tmp/x.png", "/tmp/d"], position: { x: 50, y: 0 } } as never);
    expect(setOver).toHaveBeenLastCalledWith(false);
    expect(attach).toHaveBeenLastCalledWith([
      { kind: "path", path: "/tmp/x.png" },
      { kind: "path", path: "/tmp/d" },
    ]);
    expect(dropVaultFilesOnTarget(500, 0, [{ path: "Img/a.png", isDir: false }])).toBe(false);

    off();
    expect(dropVaultFilesOnTarget(50, 0, [{ path: "Img/a.png", isDir: false }])).toBe(false);
    attach.mockClear();
    os({ type: "drop", paths: ["/tmp/x.png"], position: { x: 50, y: 0 } } as never);
    expect(attach).not.toHaveBeenCalled();
  });
});
