// Stable per-install device id. Copilot reads `obsidian-copilot:device-id:v1` from localStorage
// on its own; the host seeds it (only when absent) so it knows the id for settings seeding.

export const COPILOT_DEVICE_ID_KEY = "obsidian-copilot:device-id:v1";

function uuidv4(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  const b = globalThis.crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Returns the id stored under the key, creating (and storing) a UUIDv4 only if the key is absent.
 * localStorage failures (private mode, blocked storage) never throw: the id is then ephemeral.
 */
export function ensureDeviceId(
  storage: Pick<Storage, "getItem" | "setItem"> | undefined = safeStorage(),
  key = COPILOT_DEVICE_ID_KEY,
): string {
  try {
    const existing = storage?.getItem(key);
    if (existing) return existing;
  } catch {
    /* fall through to a fresh id */
  }
  const id = uuidv4();
  try {
    storage?.setItem(key, id);
  } catch {
    /* ephemeral id */
  }
  return id;
}

function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}
