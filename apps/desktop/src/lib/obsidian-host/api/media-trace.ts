// Diagnostics for plugin-triggered sound and notifications. Observes only: every wrapper calls the
// original unchanged, so plugin behaviour is the same with or without it.
//
// What is observed (named by the plugin whose script is on the call stack, as `Notice` does):
//   new Audio(), HTMLMediaElement.play(), new AudioContext(), AudioScheduledSourceNode.start()
//   (the Web Audio way to sound a tone; the starts of one tone are coalesced into one "sound"),
//   new Notification().
// `localStorage["writer.hostMediaTrace"] = "1"` logs each of them with the plugin id. More than
// `SOUND_STORM_PLAYS` sounds from one plugin within `SOUND_STORM_WINDOW_MS` logs a
// `sound storm: <plugin id> ...` console warning (console.warn reaches the local log files).
import { callerPluginId } from "./core";

export const SOUND_STORM_PLAYS = 3;
export const SOUND_STORM_WINDOW_MS = 10_000;
/** Oscillator starts closer together than this belong to the same tone. */
const SAME_SOUND_MS = 150;

type Win = Window & typeof globalThis;
type AnyFn = (...args: unknown[]) => unknown;

const soundTimes = new Map<string, number[]>();
const lastStart = new Map<string, number>();

function traceOn(): boolean {
  try {
    return globalThis.localStorage?.getItem("writer.hostMediaTrace") === "1";
  } catch {
    return false;
  }
}

/** Test hook: forgets the repeat counters. */
export function resetMediaTrace(): void {
  soundTimes.clear();
  lastStart.clear();
}

function recordMedia(kind: string, isSound: boolean, detail = ""): void {
  const owner = callerPluginId();
  const now = Date.now();
  if (kind === "AudioScheduledSourceNode.start") {
    const prev = lastStart.get(owner);
    lastStart.set(owner, now);
    if (prev !== undefined && now - prev < SAME_SOUND_MS) return;
  }
  // Sounds are rare, so they always reach the log files (console.warn is forwarded there); the
  // chattier non-sound calls need the opt-in flag. The release app has no dev console to set it in.
  if (isSound) console.warn(`[plugin] sound: ${kind} from ${owner}${detail ? ` ${detail}` : ""}`);
  else if (traceOn())
    console.info(`[plugin] media ${kind} from ${owner}${detail ? ` ${detail}` : ""}`);
  if (!isSound) return;
  const times = (soundTimes.get(owner) ?? []).filter((t) => now - t < SOUND_STORM_WINDOW_MS);
  times.push(now);
  soundTimes.set(owner, times);
  if (times.length > SOUND_STORM_PLAYS) {
    console.warn(
      `[plugin] sound storm: ${owner} played ${times.length} sounds in ${SOUND_STORM_WINDOW_MS / 1000}s (last: ${kind}${detail ? ` ${detail}` : ""})`,
    );
  }
}

/** Installs the observers on `win`; the uninstaller restores exactly what it replaced. */
export function installMediaTrace(win: Win = window): () => void {
  const undo: (() => void)[] = [];
  const w = win as unknown as Record<string, unknown>;

  const wrapCtor = (name: string, isSound: boolean, detail?: () => string): void => {
    const Orig = w[name];
    if (typeof Orig !== "function") return;
    const proxy = new Proxy(Orig as new (...a: unknown[]) => object, {
      construct(target, args, newTarget) {
        recordMedia(`new ${name}`, isSound, detail?.());
        return Reflect.construct(target, args, newTarget);
      },
    });
    w[name] = proxy;
    undo.push(() => {
      if (w[name] === proxy) w[name] = Orig;
    });
  };

  const wrapMethod = (
    proto: object | undefined,
    method: string,
    label: string,
    isSound: boolean,
  ): void => {
    if (!proto) return;
    const desc = Object.getOwnPropertyDescriptor(proto, method);
    const Orig = desc?.value as AnyFn | undefined;
    if (typeof Orig !== "function") return;
    const wrapped = function (this: unknown, ...args: unknown[]) {
      recordMedia(label, isSound);
      return Orig.apply(this, args);
    };
    Object.defineProperty(proto, method, { ...desc, value: wrapped });
    undo.push(() => {
      if (Object.getOwnPropertyDescriptor(proto, method)?.value === wrapped)
        Object.defineProperty(proto, method, desc!);
    });
  };

  wrapCtor("Audio", false);
  wrapCtor("AudioContext", false);
  wrapCtor("webkitAudioContext", false);
  wrapCtor("Notification", false);
  wrapMethod(win.HTMLMediaElement?.prototype, "play", "HTMLMediaElement.play", true);
  const sources = (w.AudioScheduledSourceNode as { prototype?: object } | undefined)?.prototype;
  wrapMethod(sources, "start", "AudioScheduledSourceNode.start", true);

  return () => {
    for (const fn of undo.reverse()) fn();
    undo.length = 0;
  };
}
