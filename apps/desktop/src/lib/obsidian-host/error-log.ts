// Diagnostics: plugin load/enable/unload errors are also kept in a small ring buffer on
// `window.__writerPluginErrors` so end-to-end tests (and a developer's console) can read what
// went wrong without scraping the UI. The data is host-side only and never leaves the page.

export interface PluginErrorEntry {
  at: number;
  plugin: string;
  phase: string;
  message: string;
}

export const PLUGIN_ERROR_LOG_MAX = 100;

declare global {
  interface Window {
    __writerPluginErrors?: PluginErrorEntry[];
  }
}

export function errorText(e: unknown): string {
  if (e instanceof Error) return e.stack ?? `${e.name}: ${e.message}`;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e) ?? "unknown error";
  } catch {
    return "unknown error";
  }
}

export function recordPluginError(plugin: string, phase: string, e: unknown): void {
  if (typeof window === "undefined") return;
  const log = (window.__writerPluginErrors ??= []);
  log.push({ at: Date.now(), plugin, phase, message: errorText(e) });
  if (log.length > PLUGIN_ERROR_LOG_MAX) log.splice(0, log.length - PLUGIN_ERROR_LOG_MAX);
}
