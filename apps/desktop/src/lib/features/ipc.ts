// The object-argument client of one feature's Rust commands, `invoke("plugin:<id>|<command>")`. A
// feature's web half calls its generated `commands.*` from `web/ipc.ts` instead (they own the route
// and the camelCase argument names); this is used only by the agent, whose call sites pass an
// object (`tests/feature-ipc-guard.test.ts` allows nobody else, `describeFeatureIpc` pins its keys).
import { invoke } from "@tauri-apps/api/core";
import { assertFeatureId } from "./id";

export interface CommandSpec {
  args: object | undefined;
  result: unknown;
}
export type CommandMap<C> = { [K in keyof C]: CommandSpec };

/**
 * `const call = featureInvoke<MyCommands>("my-feature", manifest.rust.commands)`.
 * `C` gives the args and result type per command. `commands` (the manifest's `rust.commands`) adds
 * a runtime guard: a command the manifest does not declare rejects instead of reaching Rust, where
 * it would fail as "not allowed". The Rust contract test keeps the manifest equal to the handlers.
 */
export function featureInvoke<C extends CommandMap<C>>(id: string, commands?: readonly string[]) {
  assertFeatureId(id);
  return <K extends keyof C & string>(
    command: K,
    ...args: C[K]["args"] extends undefined ? [] : [args: C[K]["args"]]
  ): Promise<C[K]["result"]> => {
    if (commands && !commands.includes(command)) {
      return Promise.reject(new Error(`feature ${id} declares no command ${command}`));
    }
    return invoke(`plugin:${id}|${command}`, args[0] as Record<string, unknown> | undefined);
  };
}
