// Publishes which community plugins are enabled to core (`lib/community-plugins.ts`), so a built-in
// feature can yield to a plugin without reaching into the host. Follows the plugins store snapshot.
import { setRunningCommunityPlugins } from "@/lib/community-plugins";
import type { Dispose } from "@/lib/features/types";
import { usePluginsStore } from "./stores/plugins-store";

export function publishRunningPlugins(): Dispose {
  const push = () => {
    const status = usePluginsStore.getState().snapshot?.status ?? {};
    setRunningCommunityPlugins(
      Object.entries(status)
        .filter(([, s]) => s.state === "enabled")
        .map(([id]) => id),
    );
  };
  push();
  const unsubscribe = usePluginsStore.subscribe((s, prev) => {
    if (s.snapshot !== prev.snapshot) push();
  });
  return () => {
    unsubscribe();
    setRunningCommunityPlugins([]);
  };
}
