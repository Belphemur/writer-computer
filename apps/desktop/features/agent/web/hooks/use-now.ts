import { useEffect, useState } from "react";

/** A clock: one tick a second while `active`, none otherwise. The tray and a resumed run's card
 *  read their live elapsed time from it. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}
