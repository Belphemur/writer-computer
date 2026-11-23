// The graph IPC: the manifest, the generated bindings and the typed client name the same
// commands, every call goes to `plugin:graph|<command>`, and the wrappers send the argument names
// the Rust commands read (`graph_slice` takes one `request` object).
// @vitest-environment jsdom
import { describeFeatureIpc } from "@tests/helpers/feature-ipc";
import manifest from "../feature.json";
import * as ipc from "../web/ipc";

describeFeatureIpc({
  id: manifest.id,
  commands: manifest.rust.commands,
  calls: {
    graph_slice: {
      call: () => ipc.graphSlice({ center: "a.md", depth: 2 }),
      args: { request: { center: "a.md", depth: 2 } },
    },
    graph_stats: { call: () => ipc.graphStats(), args: {} },
    graph_config_read: { call: () => ipc.graphConfigRead(), args: {} },
    graph_config_write: { call: () => ipc.graphConfigWrite("c1"), args: { content: "c1" } },
  },
});
