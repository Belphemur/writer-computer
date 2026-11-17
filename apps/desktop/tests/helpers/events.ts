// Event and timing helpers shared by the component and editor tests (import as `@tests/helpers/events`).

/** Dispatch a bubbling, cancelable MouseEvent on `el` and return it, so a test can read
 *  `defaultPrevented`. */
export function dispatchMouse(el: Element, type: string, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(event);
  return event;
}

/** Let every pending promise callback and zero-delay timer run. For tests with real timers and no
 *  React `act`: under fake timers or `act`, advance them instead. */
export const flushPromises = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
