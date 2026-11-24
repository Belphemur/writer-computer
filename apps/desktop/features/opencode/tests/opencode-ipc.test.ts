// The OpenCode IPC: every wrapper of `ipc.ts` goes through the generated bindings, and
// `describeFeatureIpc` pins the route, the command set, the camelCase argument names and the value
// each argument carries.
// @vitest-environment jsdom
import { describeFeatureIpc } from "@tests/helpers/feature-ipc";
import manifest from "../feature.json";
import * as ipc from "../web/ipc";

describeFeatureIpc({
  id: manifest.id,
  commands: manifest.rust.commands,
  calls: {
    opencode_status: {
      call: () => ipc.status("/p/opencode"),
      args: { binaryOverride: "/p/opencode" },
    },
    opencode_models: { call: () => ipc.models(), args: {} },
    opencode_saved_rules: { call: () => ipc.savedRules(), args: {} },
    opencode_remove_saved_rule: {
      call: () => ipc.removeSavedRule("psv_fake1"),
      args: { id: "psv_fake1" },
    },
  },
});
