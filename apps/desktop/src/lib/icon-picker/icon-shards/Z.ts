// Hugeicons free icons starting with Z, one chunk (see ../icon-shards.ts).
import type { IconSvgElement } from "@hugeicons/react";

export default import.meta.glob<IconSvgElement>(
  "../../../../node_modules/@hugeicons/core-free-icons/dist/esm/Z*Icon.js",
  { eager: true, import: "default" },
);
