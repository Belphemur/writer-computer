// Ambient declarations for the type-check of the feature tests (`features/*/tests/tsconfig.json`):
// the untyped node modules (see `tests/env.d.ts`).
/// <reference types="vite/client" />
declare module "node:fs";
declare module "node:path";
declare module "node:os";
declare module "node:process";
declare module "node:url";
declare module "node:child_process";
interface ImportMeta {
  dirname: string;
  filename: string;
}
