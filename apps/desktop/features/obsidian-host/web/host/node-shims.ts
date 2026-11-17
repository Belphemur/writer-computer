// Compatibility re-exports: the Node surface lives in ./node/. `pathShim` is the POSIX `path`
// module; `createProcessShim` builds a standalone `process` object (the host uses the shared one).
export { pathModule as pathShim } from "./node/path";
export { createProcessShim } from "./node/process";
