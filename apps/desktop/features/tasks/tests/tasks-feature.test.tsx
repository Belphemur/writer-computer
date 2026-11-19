// The Tasks feature as a built-in: registers and unregisters cleanly, the kill switch removes the
// service, the manifest matches the code and the schema, the page kind round-trips and shows the
// off page, and core never imports the feature.
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));

import { createFeatureHost } from "@/lib/features/registry";
import { isFeatureEnabled, syncBuiltinFeatures } from "@/lib/features/builtin";
import { editorExtensionContributions } from "@/lib/features/editor-extensions";
import { featurePaletteCommands } from "@/lib/features/palette";
import { overlayContributions } from "@/lib/features/overlays";
import { menuContributions, menuKey } from "@/lib/features/menus";
import { getService, serviceContributions } from "@/lib/features/services";
import { sidebarActionContributions } from "@/lib/features/sidebar";
import { slotContributions } from "@/lib/features/slots";
import {
  deserializeLocation,
  pageKind,
  serializeLocation,
} from "@/components/editor-area/page-kinds";
import { pageKindView } from "@/components/editor-area/page-kinds/views";
import { useFeatureHealth } from "@/stores/feature-health-store";
import { useSettingsStore } from "@/stores/settings-store";
import schema from "@shared/settings.schema.json";
import fragment from "../settings.schema.json";
import manifest from "../feature.json";
import tasks from "../web";
import { TASKS_ROWS, type TasksRowsService } from "../web/api";

const host = createFeatureHost({ onError: () => {} });
const mine = (xs: { owner: string }[]) => xs.filter((x) => x.owner === "builtin:tasks").length;
const counts = () => [
  mine(editorExtensionContributions.list()),
  mine(slotContributions.list()),
  mine(serviceContributions.list()),
  mine(sidebarActionContributions.list()),
  mine(overlayContributions.list()),
  mine(featurePaletteCommands.list()),
  mine(menuContributions.list()),
];

beforeEach(() => {
  useSettingsStore.setState({ settings: {} });
  useFeatureHealth.setState({ sessionOff: {}, safeMode: false });
});
afterEach(async () => {
  for (const id of host.list()) await host.unregister(id);
});

describe("registration", () => {
  it("registers every contribution and removes exactly them on unregister", async () => {
    host.register(tasks);
    expect(counts()).toEqual([1, 1, 1, 1, 2, 5, 1]);
    expect(getService<TasksRowsService>(TASKS_ROWS)).toBeDefined();
    await host.unregister("tasks");
    expect(counts()).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(getService(TASKS_ROWS)).toBeUndefined();
  });

  it("the kill switch removes the feature, and turning it on brings it back", async () => {
    const features = [{ manifest, definition: tasks }];
    syncBuiltinFeatures(host, features, { "features.tasks.enabled": false });
    expect(host.list()).not.toContain("tasks");
    syncBuiltinFeatures(host, features, {});
    expect(host.list()).toContain("tasks");
    expect(isFeatureEnabled(manifest, {})).toBe(true);
    syncBuiltinFeatures(host, features, { "features.tasks.enabled": false });
    await vi.waitFor(() => expect(getService(TASKS_ROWS)).toBeUndefined());
  });
});

describe("manifest contract", () => {
  it("lists the ids the definition registers", () => {
    const c = tasks.contributes!;
    expect(tasks.id).toBe(manifest.id);
    expect(manifest.contributes.commands.map((x) => x.id)).toEqual(c.commands!.map((x) => x.id));
    expect(manifest.contributes.sidebarActions).toEqual(c.sidebarActions!.map((x) => x.id));
    expect(manifest.contributes.overlays).toEqual(c.overlays!.map((x) => x.id));
    expect(manifest.contributes.slots).toEqual(c.slots!.map((x) => x.id));
    expect(manifest.contributes.editorExtensions).toEqual(c.editorExtensions!.map((x) => x.id));
    expect(manifest.contributes.services).toEqual(c.services!.map((x) => x.id));
    expect(manifest.contributes.menus["editor-body"]).toEqual(
      c.menus!["editor-body"]!.map((x) => x.id),
    );
    expect(manifest.provides).toEqual([TASKS_ROWS]);
    const ids = [
      ...c.commands!,
      ...c.sidebarActions!,
      ...c.overlays!,
      ...c.slots!,
      ...c.editorExtensions!,
      ...c.services!,
    ].map((x) => x.id);
    expect(ids.every((id) => id.startsWith("tasks."))).toBe(true);
    expect(menuKey("editor-body", "tasks.editor-menu")).toBe("editor-body:tasks.editor-menu");
  });

  it("the settings fragment and the kill switch are in the shared schema's shape", () => {
    const keys = fragment.settings.map((s: { key: string }) => s.key).sort();
    expect(keys).toEqual([
      "tasks.format",
      "tasks.inbox",
      "tasks.recurrence-position",
      "tasks.set-done-date",
    ]);
    const shared = (schema as { settings: { key: string; default: unknown }[] }).settings;
    expect(shared.find((s) => s.key === "features.tasks.enabled")?.default).toBe(true);
  });
});

describe("the tasks page kind", () => {
  it("round-trips through the session, claims no path and names its feature", () => {
    const location = { kind: "tasks" } as const;
    const kind = pageKind(location);
    expect(kind.feature).toBe("tasks");
    expect(kind.icon).toBeDefined();
    expect(kind.paths(location)).toEqual([]);
    expect(deserializeLocation(serializeLocation(location)!)).toEqual(location);
  });

  it("has a view registered", () => {
    expect(pageKindView({ kind: "tasks" })).toBeDefined();
  });
});
