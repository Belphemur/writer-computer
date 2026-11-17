// Tauri events a feature emits or listens to. THE naming rule (SPECs/builtin-plugins-spec.md):
// `<id>:<name>`, with no dots. Tauri rejects any character that is not alphanumeric or one of
// `- / : _` (a `.` makes `emit` fail), so command ids such as `word-count.toggle` must never be
// reused as event names. `<name>` is stricter than Tauri: letters, digits, `-` and `_` only, so
// the first `:` always separates the owner. Mirrors `valid_event_name` in the Rust contract test.
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { assertFeatureId } from "./id";

const EVENT_NAME = /^[\p{L}\p{N}_-]+$/u;

export function featureEventName(id: string, name: string): string {
  assertFeatureId(id);
  if (!EVENT_NAME.test(name)) {
    throw new Error(`illegal event name "${name}" for feature ${id}: use letters, digits, - and _`);
  }
  return `${id}:${name}`;
}

/** The events one feature emits, typed by `E` (name -> payload). Names are auto-prefixed. */
export function featureEvents<E extends object>(id: string) {
  return {
    name: <K extends keyof E & string>(name: K) => featureEventName(id, name),
    listen<K extends keyof E & string>(name: K, fn: (payload: E[K]) => void): Promise<UnlistenFn> {
      return listen<E[K]>(featureEventName(id, name), (e) => fn(e.payload));
    },
  };
}

export type FeatureEvents<E extends object> = ReturnType<typeof featureEvents<E>>;
