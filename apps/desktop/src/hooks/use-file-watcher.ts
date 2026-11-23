import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { showEditorNotice } from "@/components/editor-area/editor-notice-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useSettingsStore } from "@/stores/settings-store";
import { emitFileChanged, type FileChangeKind } from "@/lib/features/workspace-events";
import * as editorApi from "./editor-api";
import * as tauri from "@/lib/tauri";
import { claimsExternalChange } from "@/lib/external-changes";
import { cancelSave, isSaveInFlight } from "@/lib/save";
import { isWorkspaceEventCurrent, type WorkspaceIdentity } from "@/lib/workspace-events";
import { getWorkspaceEventIdentity } from "./workspace-api";
import type { WriteResult } from "@/types/fs";

interface FileChangePayload {
  path: string;
  kind: "modified" | "created" | "deleted" | "renamed";
  workspace: WorkspaceIdentity | null;
}

interface IndexCompletePayload {
  workspace: WorkspaceIdentity;
  fileCount: number;
}

const WATCHER_DEBUG = import.meta.env.DEV;

/** Watcher kinds mapped to what features see. A rename reports the new path: `create` also
 *  drops a node whose file is gone, so both halves of a rename are covered. */
function featureEventKind(kind: FileChangePayload["kind"] | undefined): FileChangeKind {
  if (kind === "deleted") return "delete";
  if (kind === "modified") return "modify";
  return "create";
}

export function useFileWatcher() {
  useEffect(() => {
    const unlistenFile = listen<FileChangePayload>("fs:file-changed", (event) => {
      const { path, kind, workspace } = event.payload;
      if (!isWorkspaceEventCurrent(workspace, getWorkspaceEventIdentity())) return;
      if (WATCHER_DEBUG) console.debug("[watcher] fs:file-changed", kind, path);
      useWorkspaceStore.getState().bumpSidebarMetadataVersion();
      void emitFileChanged(featureEventKind(kind), path);
      const openFiles = editorApi.getOpenFiles();
      const file = openFiles.get(path);

      if (!file) return;
      if (kind === "deleted") return;
      // a feature that wrote the file itself (git's sync) hands the change to the editor its own
      // way; asked before the in-flight check, so its change is never dropped behind a save
      if (claimsExternalChange(path, kind)) return;
      if (isSaveInFlight(path)) return;

      cancelSave(path);
      void tauri.readFile(path).then((content) => {
        const latest = editorApi.getOpenFiles().get(path);
        if (!latest || content.content === latest.diskContent) return;
        if (WATCHER_DEBUG) console.debug("[watcher] reload-from-disk", path);
        editorApi.reloadFromDisk(path, content.content);
      });
    });

    const unlistenIndexComplete = listen<IndexCompletePayload>("index:complete", (event) => {
      if (isWorkspaceEventCurrent(event.payload.workspace, getWorkspaceEventIdentity())) {
        useWorkspaceStore.setState((state) => ({
          fileCount: event.payload.fileCount,
          isIndexing: false,
          sidebarMetadataVersion: state.sidebarMetadataVersion + 1,
        }));
      }
    });

    const unlistenSidebarMetadata = listen<WriteResult>("sidebar:metadata-changed", (event) => {
      const { bumpSidebarMetadataVersion, updateEntryModifiedAt } = useWorkspaceStore.getState();
      bumpSidebarMetadataVersion();
      updateEntryModifiedAt(event.payload.path, event.payload.modified_at);
    });

    const unlistenSettings = listen<WorkspaceIdentity>("settings:changed", (event) => {
      if (!isWorkspaceEventCurrent(event.payload, getWorkspaceEventIdentity())) return;
      void useSettingsStore.getState().loadSettings();
    });

    // The watcher could not start (on Linux, usually the inotify limit): the message says how to fix it.
    const unlistenWatchFailed = listen<{ message: string; workspace: WorkspaceIdentity }>(
      "fs:watch-failed",
      (event) => {
        if (!isWorkspaceEventCurrent(event.payload.workspace, getWorkspaceEventIdentity())) return;
        showEditorNotice(event.payload.message, { sticky: true });
      },
    );

    const unlistenDir = listen<FileChangePayload>("fs:directory-changed", (event) => {
      const { path, kind, workspace } = event.payload;
      if (!isWorkspaceEventCurrent(workspace, getWorkspaceEventIdentity())) return;
      if (WATCHER_DEBUG) console.debug("[watcher] fs:directory-changed", path);
      void emitFileChanged(featureEventKind(kind), path);
      const { root, expandedDirs, invalidatePath, refreshDirectory, bumpSidebarMetadataVersion } =
        useWorkspaceStore.getState();
      bumpSidebarMetadataVersion();

      // For visible directories (expanded or root), refresh in-place so the
      // old entries stay visible until new data arrives.  Calling
      // invalidatePath first would delete the cache, causing the tree to
      // flash empty while the async refresh is in flight.
      if (expandedDirs.has(path) || path === root) {
        void refreshDirectory(path);
      } else {
        invalidatePath(path);
      }

      const parent = path.substring(0, path.lastIndexOf("/"));
      if (parent) {
        if (expandedDirs.has(parent) || parent === root) {
          void refreshDirectory(parent);
        } else {
          invalidatePath(parent);
        }
      }
    });

    return () => {
      void unlistenFile.then((fn) => fn());
      void unlistenIndexComplete.then((fn) => fn());
      void unlistenSidebarMetadata.then((fn) => fn());
      void unlistenSettings.then((fn) => fn());
      void unlistenWatchFailed.then((fn) => fn());
      void unlistenDir.then((fn) => fn());
    };
  }, []);
}
