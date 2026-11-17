// The composer registers once and is found by both drops: the OS drop (agent-internal) and the
// sidebar's pointer drag through core's `lib/vault-drop-target.ts`, which hands it vault paths.
import { describe, expect, it, vi } from "vite-plus/test";
import { dropVaultFilesOnTarget } from "@/lib/vault-drop-target";
import {
  dropOnChatComposer,
  isOverChatComposer,
  registerChatImageTarget,
} from "@features/agent/web/lib/chat-image-target";

describe("chat image target", () => {
  it("is reachable from the sidebar drag as vault sources, and from the OS drop", () => {
    const attach = vi.fn();
    const off = registerChatImageTarget({ contains: (x) => x < 100, attach });
    expect(dropVaultFilesOnTarget(50, 0, ["Img/a.png"])).toBe(true);
    expect(attach).toHaveBeenLastCalledWith([{ kind: "vault", path: "Img/a.png" }]);
    expect(isOverChatComposer(50, 0)).toBe(true);
    expect(dropOnChatComposer(50, 0, [{ kind: "path", path: "/tmp/x.png" }])).toBe(true);
    expect(dropVaultFilesOnTarget(500, 0, ["Img/a.png"])).toBe(false);

    off();
    expect(dropVaultFilesOnTarget(50, 0, ["Img/a.png"])).toBe(false);
    expect(isOverChatComposer(50, 0)).toBe(false);
  });
});
