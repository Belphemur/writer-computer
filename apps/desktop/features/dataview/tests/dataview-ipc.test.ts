// The Dataview IPC: every wrapper goes through the generated bindings (`describeFeatureIpc` pins
// the route, the command set and the argument names: `notePath`).
// @vitest-environment jsdom
import { describeFeatureIpc } from "@tests/helpers/feature-ipc";
import manifest from "../feature.json";
import * as ipc from "../web/ipc";

describeFeatureIpc({
  id: manifest.id,
  commands: manifest.rust.commands,
  calls: {
    dql_lower: () => ipc.dqlLower("TABLE file.name"),
    dql_convert: () => ipc.dqlConvert("TABLE file.name", "a.md"),
  },
});
