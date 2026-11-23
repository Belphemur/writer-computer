// The tasks IPC: every wrapper goes through the generated bindings (`describeFeatureIpc` pins the
// route, the command set, the argument names and the value each carries).
// @vitest-environment jsdom
import { describeFeatureIpc } from "@tests/helpers/feature-ipc";
import manifest from "../feature.json";
import * as ipc from "../web/ipc";

const field = { field: "due", value: "2026-01-01" };

describeFeatureIpc({
  id: manifest.id,
  commands: manifest.rust.commands,
  // `task_set_field` is the CLI's (`writer task:*`); the editor sets a field on the line text.
  unwrapped: ["task_set_field"],
  calls: {
    task_add: {
      call: () => ipc.taskAdd("t1", [field], "p1"),
      args: { text: "t1", fields: [field], path: "p1" },
    },
    task_line_info: { call: () => ipc.taskLineInfo("l1"), args: { line: "l1" } },
    task_line_set: {
      call: () => ipc.taskLineSet("l1", field),
      args: { line: "l1", edit: field },
    },
    task_line_toggle: {
      call: () => ipc.taskLineToggle("l1", "d1"),
      args: { line: "l1", today: "d1" },
    },
    task_toggle: {
      call: () => ipc.taskToggle("p1", 3, "e1", "d1"),
      args: { path: "p1", line: 3, expect: "e1", today: "d1" },
    },
    tasks_convert_block: {
      call: () => ipc.tasksConvertBlock("p1", "src1", true),
      args: { path: "p1", source: "src1", write: true },
    },
    tasks_sections: { call: () => ipc.tasksSections(), args: {} },
  },
});
