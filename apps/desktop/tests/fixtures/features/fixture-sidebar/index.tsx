// Test-only feature: one of every sidebar and footer contribution, declared out of order so the
// tests can see the host sort them. `manifest` is the same `feature.json` the Rust contract test
// reads. Never shipped; lives outside `features/` so no loader or build script picks it up.
import { Folder01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { defineFeature } from "../../../../src/lib/features/registry";
import type { FeatureContext, FeatureDefinition } from "../../../../src/lib/features/types";
import manifest from "./feature.json";

export { manifest };

export const calls = { activate: 0, action: [] as FeatureContext[] };

export function EarlyPanel() {
  return <div data-testid="early-panel">early</div>;
}
export function LatePanel(): never {
  throw new Error("late panel exploded");
}
export function StatusItem({ filePath }: { filePath: string }) {
  return <span data-testid="status-item">{filePath}</span>;
}

export function fixtureSidebarFeature(overrides: { action?: () => void } = {}): FeatureDefinition {
  return defineFeature({
    id: manifest.id,
    activate: () => {
      calls.activate += 1;
    },
    contributes: {
      sidebarPanels: [
        {
          id: "fixture-sidebar.panel-late",
          label: "Late",
          icon: Search01Icon,
          order: 20,
          load: async () => LatePanel,
        },
        {
          id: "fixture-sidebar.panel-early",
          label: "Early",
          icon: Folder01Icon,
          order: 10,
          load: async () => EarlyPanel,
        },
      ],
      sidebarActions: [
        {
          id: "fixture-sidebar.action",
          label: "Fixture action",
          icon: Search01Icon,
          order: 5,
          run: (ctx) => {
            calls.action.push(ctx);
            overrides.action?.();
          },
        },
      ],
      statusItems: [
        {
          id: "fixture-sidebar.status",
          order: 1,
          load: async () => StatusItem,
        },
      ],
      menus: {
        "sidebar-file": [
          {
            id: "fixture-sidebar.file-item",
            items: (entry) => [
              { kind: "item", id: "fixture.file", text: `File ${entry.name}`, action: () => {} },
            ],
          },
        ],
        "sidebar-folder": [
          {
            id: "fixture-sidebar.folder-item",
            items: (entry) => [
              {
                kind: "item",
                id: "fixture.folder",
                text: `Folder ${entry.name}`,
                action: () => {},
              },
            ],
          },
        ],
        "sidebar-bulk": [
          {
            id: "fixture-sidebar.bulk-item",
            items: (paths) => [
              { kind: "item", id: "fixture.bulk", text: `Bulk ${paths.length}`, action: () => {} },
            ],
          },
        ],
      },
    },
  });
}
