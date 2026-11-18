// While the Hotkeys page records a key, the app's own shortcuts must not fire on it: the
// dispatcher (`use-keyboard-shortcuts.ts`) stands down while any recording is active.
let active = 0;

/** Starts a recording; call the returned function when it ends (calling it twice is harmless). */
export function beginKeyRecording(): () => void {
  active++;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    active--;
  };
}

export const isKeyRecording = () => active > 0;
