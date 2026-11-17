import { Image01Icon } from "@hugeicons/core-free-icons";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useState } from "react";
import { useWorkspaceRoot } from "@/hooks/use-workspace";
import { Ico } from "./agent-icon";

/** The asset-protocol URL of a vault-relative image, or null without a vault or a webview. */
function srcOf(root: string | null, path: string): string | null {
  if (!root || path.startsWith("/") || path.split("/").includes("..")) return null;
  try {
    return convertFileSrc(`${root.replace(/\/$/, "")}/${path}`);
  } catch {
    return null; // no Tauri runtime (tests, the playground)
  }
}

/** A small thumbnail of a chat image (composer chip, transcript). A file that cannot be shown
 *  (moved, outside the asset scope) falls back to an icon; the name stays readable elsewhere. */
export function ChatImageThumb({ path, className }: { path: string; className?: string }) {
  const root = useWorkspaceRoot();
  const [failed, setFailed] = useState(false);
  const src = srcOf(root, path);
  if (!src || failed)
    return (
      <span
        data-agent-image-fallback
        className={`inline-flex items-center justify-center text-text-muted ${className ?? ""}`}
      >
        <Ico icon={Image01Icon} size={14} />
      </span>
    );
  return (
    <img
      src={src}
      alt=""
      draggable={false}
      data-agent-image-thumb
      onError={() => setFailed(true)}
      className={`object-cover ${className ?? ""}`}
    />
  );
}
