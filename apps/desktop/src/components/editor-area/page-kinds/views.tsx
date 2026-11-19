import type { ReactNode } from "react";
import { EditorPane } from "../editor-pane";
import { DocumentFooter } from "../document-footer";
import { NewTabPage } from "../new-tab-page";
import { ManagedSkillBanner } from "../managed-skill-banner";
import { FeatureOffPage } from "@/components/feature-off-page";
import { FeatureSlot } from "@/components/feature-slot";
import { openFileAsTextInNewTab } from "@/hooks/editor-api";
import { openAttachmentInDefaultApp } from "@/lib/tauri";
import { useFeatureActive } from "@/lib/features/active";
import { SettingsPanel } from "@/components/settings-panel";
import type { PageViewProps } from "@/lib/features/slots";
import type { Location } from "./index";
import type { BaseLocation } from "./base";
import type { CodeLocation } from "./code";
import type { DrawingLocation } from "./drawing";
import type { FileLocation } from "./file";
import type { GraphLocation } from "./graph";
import type { ImageLocation } from "./image";
import type { LauncherLocation } from "./launcher";
import type { PdfLocation } from "./pdf";
import type { PluginFileLocation } from "./plugin-file";
import type { PluginViewLocation } from "./plugin-view";
import type { SessionChangesLocation } from "./session-changes";
import type { SettingsLocation } from "./settings";
import type { TasksLocation } from "./tasks";
import type { PageKindView } from "./types";

/**
 * View registry — maps each page kind to its React tab body (and optional
 * footer chrome). Kept separate from the behavior registry (`./index`) so the
 * editor UI tree is imported only by the renderer that mounts tabs, never by
 * the data/serialization layer (stores, hooks). Without this split, importing
 * the registry to (de)serialize a location dragged the whole editor UI into
 * the stores and produced import cycles. Register a kind's view here alongside
 * its behavior module.
 */
// `file` needs a small adapter because EditorPane is keyed by `path`, not by
// the location object; `launcher`/`settings` reference their components
// directly (extra props are ignored), keeping this file to a single component
// definition.
// Page-kind view registry: exports the pageKindView resolver alongside the file-tab adapter component; not a Fast-Refresh component surface.
// eslint-disable-next-line react-doctor/only-export-components
const FileTabBody = ({ location, isActive }: { location: FileLocation; isActive: boolean }) => (
  <>
    <EditorPane path={location.path} isActive={isActive} />
    {isActive ? <ManagedSkillBanner path={location.path} /> : null}
  </>
);

// A kind whose body a feature supplies (the plugin page kinds of the Obsidian host, the base
// view): the slot `page-view:<kind>` renders it while the feature is on. While it is off, a kind
// that names its feature (`PageKind.feature`) shows the "turned off" page with `offActions`;
// the others show nothing.
function featureView<K extends Location["kind"]>(
  kind: K,
  off?: {
    feature: string;
    actions?: (location: Extract<Location, { kind: K }>) => ReactNode;
  },
) {
  const Component = (props: PageViewProps<Extract<Location, { kind: K }>>) => {
    const active = useFeatureActive(off?.feature ?? "");
    if (off && !active) {
      return <FeatureOffPage feature={off.feature} actions={off.actions?.(props.location)} />;
    }
    return <FeatureSlot slot={`page-view:${kind}`} {...props} />;
  };
  return { Component };
}

// The way out of a feature's off page for a file kind (`.base`, code files): open it as text.
function OpenAsTextButton({ path }: { path: string }) {
  return (
    <button
      type="button"
      onClick={() => void openFileAsTextInNewTab(path)}
      className="rounded-md border border-[var(--line-subtle)] px-2.5 py-1 text-[var(--text-primary)] hover:bg-[var(--item-hover-bg)]"
    >
      Open as text
    </button>
  );
}

function OpenInDefaultAppButton({ path }: { path: string }) {
  return (
    <button
      type="button"
      onClick={() => void openAttachmentInDefaultApp(path)}
      className="rounded-md border border-[var(--line-subtle)] px-2.5 py-1 text-[var(--text-primary)] hover:bg-[var(--item-hover-bg)]"
    >
      Open in default app
    </button>
  );
}

const views = {
  file: {
    Component: FileTabBody,
    renderFooter: (l) => <DocumentFooter filePath={l.path} />,
  } satisfies PageKindView<FileLocation>,
  code: featureView("code", {
    feature: "code-files",
    actions: (location) => <OpenAsTextButton path={location.path} />,
  }) satisfies PageKindView<CodeLocation>,
  image: featureView("image", {
    feature: "images",
    actions: (location) => <OpenInDefaultAppButton path={location.path} />,
  }) satisfies PageKindView<ImageLocation>,
  pdf: featureView("pdf", {
    feature: "pdf",
    actions: (location) => <OpenInDefaultAppButton path={location.path} />,
  }) satisfies PageKindView<PdfLocation>,
  drawing: featureView("drawing", {
    feature: "excalidraw",
    actions: (location) => <OpenAsTextButton path={location.path} />,
  }) satisfies PageKindView<DrawingLocation>,
  base: featureView("base", {
    feature: "bases",
    actions: (location) => <OpenAsTextButton path={location.path} />,
  }) satisfies PageKindView<BaseLocation>,
  graph: featureView("graph", { feature: "graph" }) satisfies PageKindView<GraphLocation>,
  tasks: featureView("tasks", { feature: "tasks" }) satisfies PageKindView<TasksLocation>,
  launcher: {
    Component: NewTabPage,
  } satisfies PageKindView<LauncherLocation>,
  settings: {
    Component: SettingsPanel,
  } satisfies PageKindView<SettingsLocation>,
  "plugin-view": featureView("plugin-view") satisfies PageKindView<PluginViewLocation>,
  "plugin-file": featureView("plugin-file") satisfies PageKindView<PluginFileLocation>,
  "session-changes": featureView("session-changes", {
    feature: "agent",
  }) satisfies PageKindView<SessionChangesLocation>,
} as const;

/** Resolve a location to its registered view. Throws on an unknown kind —
 *  always a programmer error, mirroring `pageKind` in `./index`. */
export function pageKindView(location: Location): PageKindView {
  const view = views[location.kind as keyof typeof views];
  if (!view) throw new Error(`No view registered for page kind: ${location.kind}`);
  return view as PageKindView;
}
