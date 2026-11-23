// The Dataview IPC: every wrapper goes through the generated bindings (`describeFeatureIpc` pins
// the route, the command set, the argument names (`notePath`) and values).
// @vitest-environment jsdom
import { describeFeatureIpc } from "@tests/helpers/feature-ipc";
import manifest from "../feature.json";
import * as ipc from "../web/ipc";

describeFeatureIpc({
  id: manifest.id,
  commands: manifest.rust.commands,
  calls: {
    dql_lower: { call: () => ipc.dqlLower("q1"), args: { text: "q1" } },
    dql_convert: {
      call: () => ipc.dqlConvert("q1", "n1"),
      args: { text: "q1", notePath: "n1" },
    },
  },
});
