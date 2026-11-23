// The lint IPC: every wrapper goes through the generated bindings (`describeFeatureIpc` pins the
// route, the command set and the argument names).
// @vitest-environment jsdom
import { describeFeatureIpc } from "@tests/helpers/feature-ipc";
import manifest from "../feature.json";
import * as ipc from "../web/ipc";

describeFeatureIpc({
  id: manifest.id,
  commands: manifest.rust.commands,
  calls: {
    lint_check: () => ipc.check("text"),
    lint_fix: () => ipc.fix("text", "all", [{ from: 0, to: 1 }]),
  },
});
