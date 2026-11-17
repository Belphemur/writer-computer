// The engine's function registry (name, receivers, signature, doc, return type) for the
// expression editor, fetched once per session. The Rust `FUNCTIONS` table is the only source.
import { baseFunctions } from "../ipc";
import type { BaseFunctionInfo } from "./types";

let cached: Promise<BaseFunctionInfo[]> | null = null;

/**
 * The registry. Concurrent callers share one request; a failure is not cached, so the next call
 * asks again and the caller shows the error instead of working with an empty list.
 */
export function loadFunctionRegistry(): Promise<BaseFunctionInfo[]> {
  if (cached) return cached;
  const request = baseFunctions();
  const guarded = request.catch((e: unknown) => {
    if (cached === guarded) cached = null;
    throw e;
  });
  cached = guarded;
  return guarded;
}

/** For tests: forget the cached registry. */
export function resetFunctionRegistry(): void {
  cached = null;
}
