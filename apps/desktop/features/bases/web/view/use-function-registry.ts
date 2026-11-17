import { useEffect, useState } from "react";
import { loadFunctionRegistry } from "../lib/function-registry";
import type { BaseFunctionInfo } from "../lib/types";
import { errorMessage } from "./use-base-query";

const NONE: readonly BaseFunctionInfo[] = [];

/**
 * The engine's function registry for the expression editor (one request per session, shared by
 * every editor). `error` is set when it could not be loaded; completion then still offers
 * namespaces, properties and keywords, and the editor says why functions are missing.
 */
export function useFunctionRegistry(): {
  functions: readonly BaseFunctionInfo[];
  error: string | null;
} {
  const [state, setState] = useState<{
    functions: readonly BaseFunctionInfo[];
    error: string | null;
  }>({ functions: NONE, error: null });
  useEffect(() => {
    let live = true;
    loadFunctionRegistry().then(
      (functions) => live && setState({ functions, error: null }),
      (e) => live && setState({ functions: NONE, error: errorMessage(e) }),
    );
    return () => {
      live = false;
    };
  }, []);
  return state;
}
