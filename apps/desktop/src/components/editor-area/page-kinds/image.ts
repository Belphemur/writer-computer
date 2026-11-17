import { isRenderableImageName } from "@/lib/attachments";
import { getFileName } from "@/lib/paths";
import { definePageKind } from "./types";

/**
 * An image file (png, jpg, gif, webp, svg, avif, bmp) in the read-only image viewer. Claimed by
 * `forPath` for the renderable image extensions (`shared/attachments.json`), whatever
 * `files.show-images` says: that setting only decides whether the sidebar lists images. The path
 * is not a text document (`loadsDocument: false`): the view loads it through the asset protocol.
 */
export type ImageLocation = { kind: "image"; path: string };

export const imageKind = definePageKind<"image", ImageLocation>({
  kind: "image",
  title: (l) => getFileName(l.path),
  description: "Image",
  keepAlive: true,
  supportsFileContextMenu: true,
  loadsDocument: false,
  forPath: (path) => (isRenderableImageName(getFileName(path)) ? { kind: "image", path } : null),
  fromPayload: (data) =>
    typeof data.path === "string" ? { kind: "image", path: data.path } : null,
  paths: (l) => [l.path],
  primaryPath: (l) => l.path,
  rewritePath: (l, from, to) => (l.path === from ? { ...l, path: to } : l),
  removePath: (l, path) => (l.path === path ? null : l),
  serialize: (l) => ({ path: l.path }),
});
