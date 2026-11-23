// The tasks IPC: every wrapper goes through the generated bindings (`describeFeatureIpc` pins the
// route, the command set and the argument names).
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
    task_add: () => ipc.taskAdd("t", [field], "a.md"),
    task_line_info: () => ipc.taskLineInfo("- [ ] t"),
    task_line_set: () => ipc.taskLineSet("- [ ] t", field),
    task_line_toggle: () => ipc.taskLineToggle("- [ ] t", "2026-01-01"),
    task_toggle: () => ipc.taskToggle("a.md", 3, "- [ ] t", "2026-01-01"),
    tasks_convert_block: () => ipc.tasksConvertBlock("a.md", "src", true),
    tasks_sections: () => ipc.tasksSections(),
  },
});
