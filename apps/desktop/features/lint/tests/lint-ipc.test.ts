// The lint IPC: every wrapper goes through the generated bindings (`describeFeatureIpc` pins the
// route, the command set, the argument names and values).
// @vitest-environment jsdom
import { describeFeatureIpc } from "@tests/helpers/feature-ipc";
import manifest from "../feature.json";
import * as ipc from "../web/ipc";

describeFeatureIpc({
  id: manifest.id,
  commands: manifest.rust.commands,
  calls: {
    lint_check: { call: () => ipc.check("t1"), args: { request: { text: "t1" } } },
    lint_fix: {
      call: () => ipc.fix("t1", "all", [{ from: 0, to: 1 }]),
      args: { request: { text: "t1", scope: "all", keep: [{ from: 0, to: 1 }] } },
    },
  },
});
