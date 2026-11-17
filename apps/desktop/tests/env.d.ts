// Ambient declarations for the type-check of `tests/` (`tests/tsconfig.json`): vite's client types
// and the node modules the tests import. The project has no `@types/node`, so these are untyped
// on purpose.
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
