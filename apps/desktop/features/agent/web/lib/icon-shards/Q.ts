// Hugeicons free icons starting with Q, one chunk (see ../project-icon-shards.ts).
import type { IconSvgElement } from "@hugeicons/react";

export default import.meta.glob<IconSvgElement>(
  "../../../../../node_modules/@hugeicons/core-free-icons/dist/esm/Q*Icon.js",
  { eager: true, import: "default" },
);
