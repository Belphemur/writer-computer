// Hugeicons free icons starting with G, one chunk (see ../project-icon-shards.ts).
import type { IconSvgElement } from "@hugeicons/react";

export default import.meta.glob<IconSvgElement>(
  "../../../../../node_modules/@hugeicons/core-free-icons/dist/esm/G*Icon.js",
  { eager: true, import: "default" },
);
