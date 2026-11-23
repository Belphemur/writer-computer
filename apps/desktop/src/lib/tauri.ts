import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask, open as openDialog } from "@tauri-apps/plugin-dialog";
import sidebarEntryKinds from "@shared/sidebar-entry-kinds.json";
import type { FeaturesStatus } from "@/stores/feature-health-store";
import type { DirEntry, FileContent, SearchResult, WriteResult, WorkspaceInfo } from "@/types/fs";

// Filesystem commands
export function readDirectory(path: string): Promise<DirEntry[]> {
  return invoke("read_directory", { path });
}

/** Failure containment report (`features_status`): safe mode, what a crash turned off, failures. */
export function featuresStatus(): Promise<FeaturesStatus> {
  return invoke("features_status");
}

/** Leave safe mode: Rust resets the startup counter and restarts the app. */
export function featuresRestartNormally(): Promise<void> {
  return invoke("features_restart_normally");
}

// Keyboard shortcut overrides (`hotkeys.json` in the app data dir, validated by Rust; the registry
// side is `lib/keybindings/overrides.ts`).
/** The file's text, or null when the user has changed nothing. Rejects when the file is invalid. */
export function hotkeysRead(): Promise<string | null> {
  return invoke("hotkeys_read");
}

/** Validates, replaces the file atomically and tells every window to reload. */
export function hotkeysWrite(content: string): Promise<void> {
  return invoke("hotkeys_write", { content });
}

/** The open vault's `.obsidian/hotkeys.json` text (read-only), or null when it has none. */
export function hotkeysReadObsidian(): Promise<string | null> {
  return invoke("hotkeys_read_obsidian");
}

export function readRecentFiles(limit: number, offset: number): Promise<DirEntry[]> {
  return invoke("read_recent_files", { limit, offset });
}

export function readFileEntries(paths: string[]): Promise<DirEntry[]> {
  return invoke("read_file_entries", { paths });
}

export function readFile(path: string): Promise<FileContent> {
  return invoke("read_file", { path });
}

export function writeFile(path: string, content: string): Promise<WriteResult> {
  return invoke("write_file", { path, content });
}

export function createFile(path: string): Promise<FileContent> {
  return invoke("create_file", { path });
}

export function createDirectory(path: string): Promise<DirEntry> {
  return invoke("create_directory", { path });
}

export type SidebarEntryKind = keyof typeof sidebarEntryKinds;

export function createSidebarEntry(parentPath: string, kind: SidebarEntryKind): Promise<DirEntry> {
  return invoke("create_sidebar_entry", { parentPath, kind });
}

export function renameEntry(oldPath: string, newPath: string): Promise<void> {
  return invoke("rename_entry", { oldPath, newPath });
}

export interface RelocateResult {
  links: number;
  files: number;
  skipped: number;
  /** False when the index was still building: the file moved but links were not updated. */
  linksUpdated: boolean;
}

/** Rename/move one file or folder and rewrite every link to a file (`relocate::plan`/`apply`,
 *  the code behind `writer move`). */
export function relocateEntry(oldPath: string, newPath: string): Promise<RelocateResult> {
  return invoke("relocate_entry", { oldPath, newPath });
}

/** Resolve a wikilink target (no brackets/alias/heading) written in `sourcePath` to an absolute
 *  path with the vault index's file-name rules; null when nothing matches. */
export function resolveWikiLinkTarget(
  target: string,
  sourcePath: string | null,
): Promise<string | null> {
  return invoke("resolve_wiki_link", { target, sourcePath });
}

export function deleteEntry(path: string): Promise<void> {
  return invoke("delete_entry", { path });
}

export function fileExists(path: string): Promise<boolean> {
  return invoke("file_exists", { path });
}

/** Case-insensitive basename lookup across the workspace (gitignore-aware
 *  walk; shortest path wins on duplicates). Used by wiki image embeds. */
export function findFileByName(root: string, fileName: string): Promise<string | null> {
  return invoke("find_file_by_name", { root, fileName });
}

/** Vault-relative paths of every file named exactly `fileName` (extension included, case
 *  ignored), shallowest first; backed by `find_files_by_exact_name` (index `files.name`). */
export function findFilesByExactName(fileName: string): Promise<string[]> {
  return invoke("find_files_by_exact_name", { fileName });
}

// Local log files (the frontend writes through `@/lib/logger`, never `log_event` directly)
export interface LogInfo {
  dir: string;
  /** `WRITER_LOG` is set and wins over the Logs setting. */
  envOverride: boolean;
}

export function getLogInfo(): Promise<LogInfo> {
  return invoke("log_info");
}

export function openLogFolder(): Promise<void> {
  return invoke("open_log_folder");
}

export function recentLogErrors(limit = 200): Promise<string[]> {
  return invoke("recent_log_errors", { limit });
}

// The `writer` command on the user's PATH (Rust: `commands/shell_install.rs`, `cli_install.rs`)
export interface CliInstallStatus {
  /** Where the link is (or would be): `/usr/local/bin/writer`, `~/.local/bin/writer` or the package's `/usr/bin/writer`. */
  target: string;
  installed: boolean;
  state: "missing" | "installed" | "stale" | "foreign";
  /** The target's folder is on the login shell's PATH. */
  onPath: boolean;
  /** The link belongs to the .deb/.rpm: nothing to install or remove here. */
  package: boolean;
}

export function cliStatus(): Promise<CliInstallStatus> {
  return invoke("cli_status");
}

export function installCli(): Promise<CliInstallStatus> {
  return invoke("install_cli");
}

export function uninstallCli(): Promise<CliInstallStatus> {
  return invoke("uninstall_cli");
}

export function revealInFileManager(path: string): Promise<void> {
  return invoke("reveal_in_file_manager", { path });
}

/** The bytes of a PDF for the reader (Rust refuses anything that is not a document type, or a
 *  path this window may not reach). */
export async function readDocument(path: string): Promise<Uint8Array> {
  return new Uint8Array(await invoke<ArrayBuffer>("read_document", { path }));
}

/** An image or PDF file in the OS default app (Rust refuses any other type). */
export function openAttachmentInDefaultApp(path: string): Promise<void> {
  return invoke("open_attachment_in_default_app", { path });
}

// Workspace commands
export function openWorkspace(path: string): Promise<WorkspaceInfo> {
  return invoke("open_workspace", { path });
}

export function closeWorkspace(root: string): Promise<void> {
  return invoke("close_workspace", { root });
}

export function openWorkspaceInFileManager(): Promise<void> {
  return invoke("open_workspace_in_file_manager");
}

export function openDirectoryInTerminal(path: string | null): Promise<void> {
  return invoke("open_workspace_in_terminal", { path });
}

/** Open a new in-process window for the given workspace. Each window owns
 *  its own per-window `WorkspaceState` on the Rust side (watcher, file
 *  index, settings layer) so two windows hosting different workspaces don't
 *  share file events or search results. Pass `file` to have the new window
 *  focus a specific markdown file inside the workspace. If another window
 *  already hosts `path`, that window is focused instead. */
export function openWorkspaceInNewWindow(path: string, file?: string | null): Promise<void> {
  return invoke("open_workspace_in_new_window", { path, file: file ?? null });
}

/** Bundled startup-restore IPC. Returns workspace info, root directory
 *  entries, the recents list, the persisted session, and (when available)
 *  the active tab's file content in a single round trip. */
export interface RestoreWorkspaceResponse {
  workspace: WorkspaceInfo;
  entries: DirEntry[];
  recent_workspaces: string[];
  session: SessionData | null;
  active_file: FileContent | null;
  open_file: string | null;
}

export function restoreWorkspace(path: string): Promise<RestoreWorkspaceResponse> {
  return invoke("restore_workspace", { path });
}

export async function pickWorkspace(): Promise<string | null> {
  const selected = await openDialog({
    directory: true,
    multiple: false,
    title: "Open Folder",
  });
  return selected;
}

export async function pickFile(): Promise<string | null> {
  const selected = await openDialog({
    directory: false,
    multiple: false,
    title: "Open File",
    filters: [{ name: "Markdown", extensions: ["md", "mdx", "markdown", "txt"] }],
  });
  return selected;
}

export function getRecentWorkspaces(): Promise<string[]> {
  return invoke("get_recent_workspaces");
}

export function removeRecentWorkspace(path: string): Promise<void> {
  return invoke("remove_recent_workspace", { path });
}

/** Open a markdown file in a standalone compact window (no workspace). If a
 *  standalone window already hosts the file, it is focused instead. */
export function openFileInStandaloneWindow(path: string): Promise<void> {
  return invoke("open_file_in_standalone_window", { path });
}

/** Point this window's watcher at a single standalone file (parent-dir,
 *  non-recursive). Call whenever the standalone compact window switches
 *  files. */
export function watchStandaloneFile(path: string): Promise<void> {
  return invoke("watch_standalone_file", { path });
}

// Global recents (persisted across workspaces in the app data dir)
/** A recently-opened file with its last-opened time. `opened_at` is unix
 *  seconds; `0` marks a legacy entry whose open time is unknown. */
export interface RecentFile {
  path: string;
  name: string;
  title: string | null;
  opened_at: number;
}

export function recordRecentFile(path: string): Promise<void> {
  return invoke("record_recent_file", { path });
}

export function removeRecentFile(path: string): Promise<void> {
  return invoke("remove_recent_file", { path });
}

export function getRecentFilesGlobal(limit?: number): Promise<RecentFile[]> {
  return invoke("get_recent_files_global", { limit: limit ?? null });
}

// Session commands
export interface SessionData {
  tabs?: SessionTabData[];
  active_index?: number | null;
  /** The agent pane's open chats; absent in older session files. */
  agent_chats?: AgentChatsData | null;
}

export interface AgentChatRefData {
  chat_id: string;
  /** CLI session to resume on the next send (the chat note holds it too). */
  session_id?: string | null;
}

export interface AgentChatsData {
  chats?: AgentChatRefData[];
  active_chat_id?: string | null;
}

export function saveAgentChats(
  workspaceRoot: string,
  chats: AgentChatRefData[],
  activeChatId: string | null,
): Promise<void> {
  return invoke("save_agent_chats", { workspaceRoot, chats, activeChatId });
}

export interface SerializedLocationData {
  kind: string;
  [key: string]: unknown;
}

export interface SessionTabData {
  location: SerializedLocationData;
  back: SerializedLocationData[];
  forward: SerializedLocationData[];
  /** Pinned tab; omitted when false, absent in older session files. */
  pinned?: boolean;
}

export function saveSession(
  workspaceRoot: string,
  tabs: SessionTabData[],
  activeIndex: number | null,
): Promise<void> {
  return invoke("save_session", { workspaceRoot, tabs, activeIndex });
}

export function loadSession(workspaceRoot: string): Promise<SessionData | null> {
  return invoke("load_session", { workspaceRoot });
}

// Search commands
export function fuzzySearch(
  query: string,
  limit?: number,
  kinds?: string[],
): Promise<SearchResult[]> {
  return invoke("fuzzy_search", { query, limit, kinds });
}

// Font commands
export function listSystemFonts(): Promise<string[]> {
  return invoke("list_system_fonts");
}

// Terminals found on this machine (the Default Terminal dropdown)
export interface TerminalInfo {
  id: string;
  label: string;
  /** Every name a stored value may use for it. */
  names: string[];
}

export function listTerminals(): Promise<TerminalInfo[]> {
  return invoke("list_terminals");
}

// Settings commands
export function getSettings(): Promise<Record<string, unknown>> {
  return invoke("get_settings");
}

export function getSetting(key: string): Promise<unknown> {
  return invoke("get_setting", { key });
}

export function setSetting(
  key: string,
  value: unknown,
  scope: "global" | "workspace" = "global",
): Promise<unknown> {
  return invoke("set_setting", { key, value, scope });
}

export function resetSetting(key: string, scope: "global" | "workspace" = "global"): Promise<void> {
  return invoke("reset_setting", { key, scope });
}

// Telemetry consent. Enabling/disabling and the email itself go through the
// normal `setSetting` path above — these two only cover the one-time prompt.
export function telemetryShouldPrompt(): Promise<boolean> {
  return invoke("telemetry_should_prompt");
}

export function telemetryMarkPrompted(): Promise<void> {
  return invoke("telemetry_mark_prompted");
}

/** Report a declined prompt. Disclosed in the dialog and in `docs/telemetry.md`
 *  — the one thing sent on behalf of someone who said no. */
export function telemetryReportDeclined(): Promise<void> {
  return invoke("telemetry_report_declined");
}

// Pending open queue (drag-drop / CLI arg / dock open). A folder open
// carries `workspace`; a markdown-file open carries only `file` and opens
// standalone (compact window, no workspace).
export interface PendingOpenPayload {
  workspace: string | null;
  file: string | null;
}

export function takePendingOpen(): Promise<PendingOpenPayload | null> {
  return invoke("take_pending_open");
}

// Startup state (single IPC call for all initialization data). The settings
// schema is NOT included — it's a build-time constant that the frontend
// imports statically from `@/lib/settings-schema` rather than fetching over
// IPC. Rust still uses the JSON internally (config.rs::settings_schema) for
// defaults; the IPC just doesn't expose it to TS.
export interface StartupState {
  settings: Record<string, unknown>;
  recent_workspaces: string[];
  restore_bundle: RestoreWorkspaceResponse | null;
  /** Standalone compact-mode open (CLI arg / drag-drop of a markdown file).
   *  Mutually exclusive with `restore_bundle`; the single-file watcher is
   *  already running by the time this returns. */
  standalone_file: FileContent | null;
}

export function getStartupState(): Promise<StartupState> {
  return invoke("get_startup_state");
}

// The CLI-to-app socket (`src-tauri/src/ipc/`): this window listens for `ipc:request` events and
// answers each through `ipcReply`; `ipcReady` says it can take requests (its startup resolved).
export function ipcReady(): Promise<void> {
  return invoke("ipc_ready");
}

/** The answer to request `id`: `result` when it worked, `error` (a short message) when not. */
export function ipcReply(
  id: string,
  answer: { result: unknown } | { error: string },
): Promise<void> {
  return invoke("ipc_reply", {
    id,
    result: "result" in answer ? answer.result : null,
    error: "error" in answer ? answer.error : null,
  });
}

// Window commands
export function showMainWindow(): Promise<void> {
  return getCurrentWindow().show();
}

/** Request a close of this window. Goes through the close-requested event,
 *  so the main window is hidden rather than destroyed (`lib.rs`). */
export function closeWindow(): Promise<void> {
  return getCurrentWindow().close();
}

export function minimizeWindow(): Promise<void> {
  return getCurrentWindow().minimize();
}

export function toggleMaximizeWindow(): Promise<void> {
  return getCurrentWindow().toggleMaximize();
}

export function isWindowMaximized(): Promise<boolean> {
  return getCurrentWindow().isMaximized();
}

/** Calls `handler` on every resize of this window; resolves to the unsubscribe function. */
export function onWindowResized(handler: () => void): Promise<() => void> {
  return getCurrentWindow().onResized(handler);
}

/** The desktop's own title bar and buttons on or off (Linux, setting `appearance.native-decorations`). */
export function setWindowDecorations(decorated: boolean): Promise<void> {
  return getCurrentWindow().setDecorations(decorated);
}

/** Quit the app through the same exit path as the macOS quit item (Linux's Ctrl+Q). */
export function quitApp(): Promise<void> {
  return invoke("quit_app");
}

/** Open the app menu at the pointer (Linux; `app_menu::app_menu_popup`). */
export function openAppMenu(): Promise<void> {
  return invoke("app_menu_popup");
}

// Image commands (spec: SPECs/image-insertion-spec.md)
export interface AttachmentSaved {
  /** Vault-relative (note-relative in a standalone window). */
  relative_path: string;
  absolute_path: string;
  file_name: string;
  /** False: already in the vault, linked in place (nothing was copied). */
  copied: boolean;
}

function utf8ToBase64(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Save pasted or browser-dropped image bytes next to the vault's attachments. The bytes travel
 *  as the raw request body; the note and the wanted name ride in a header. */
export function saveAttachment(
  notePath: string,
  name: string,
  bytes: Uint8Array,
): Promise<AttachmentSaved> {
  const meta = utf8ToBase64(JSON.stringify({ note_path: notePath, name }));
  return invoke("save_attachment", bytes, { headers: { "x-writer-meta": meta } });
}

/** A file of any type dropped from Finder onto a note: copied into the attachment folder by path,
 *  or, already in the vault, returned to be linked in place (`copied` false). Rejects with a
 *  terse sentence for a secret-looking name, an oversize file or a folder. */
export function importAttachmentFile(
  notePath: string,
  sourcePath: string,
): Promise<AttachmentSaved> {
  return invoke("import_attachment_file", { notePath, sourcePath });
}

/** What dropping one Finder item on a vault folder did (`src-tauri/src/dropped.rs`); paths are
 *  vault-relative. */
export type DropOutcome =
  | { kind: "copied"; path: string; isDir: boolean; files: number; skipped: number }
  | { kind: "inVault"; path: string; isDir: boolean }
  | { kind: "refused"; name: string; message: string };

/** The sidebar's drop: copies Finder items into `destDir` (absolute; folders recursively) and
 *  reports the ones already in the vault so the caller moves them. */
export function dropImport(destDir: string, sources: string[]): Promise<DropOutcome[]> {
  return invoke("drop_import", { destDir, sources });
}

/** Download an image a browser drag or paste carried only as a link (http and https), save it
 *  to the attachment folder. Rejects with a short sentence saying why it was refused. */
export function importAttachmentUrl(
  notePath: string,
  url: string,
  fallbackStem: string,
): Promise<AttachmentSaved> {
  return invoke("import_attachment_url", { notePath, url, fallbackStem });
}

/** Native yes/no confirmation. Resolves to whether the user accepted. */
export function confirmAction(message: string, title: string): Promise<boolean> {
  return ask(message, { title, kind: "warning" });
}
