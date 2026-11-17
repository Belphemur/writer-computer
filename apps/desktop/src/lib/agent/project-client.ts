/**
 * Project commands (spec section 4, lane 3). `client.ts` stays the one module for the chat
 * transport; the project commands are plain request/response calls with their own file so
 * lane 2 and lane 3 never edit the same one. Types extend the shared contract in `events.ts`.
 */
import { callAgent as call } from "../../../features/agent/web/ipc";
import type { NewProjectRequest, ProjectInfo } from "./events";

/** `ProjectInfo` plus what the contract has no field for (a superset on the wire). */
export type ProjectDetail = ProjectInfo & {
  /** Entries of the inclusion/exclusion lists with an unrecognised shape (warning rows). */
  unsupported: string[];
  webUrls: string[];
  youtubeUrls: string[];
  /** `writer-agent-mode`: `manual` or `acceptEdits`. */
  agentMode: string | null;
  warnings: string[];
};

export type ProjectUpdate = {
  name?: string;
  description?: string;
  inclusions?: string[];
  exclusions?: string[];
  webUrls?: string[];
  youtubeUrls?: string[];
  /** Empty string removes the key. */
  agentMode?: string;
  touchLastUsed?: boolean;
};

export type FolderInspection = {
  path: string;
  name: string;
  isProject: boolean;
  hasProjectMd: boolean;
  hasAgentsMd: boolean;
  hasClaudeMd: boolean;
};

export type ManifestEntry = {
  kind: "folder" | "note" | "tag" | "property" | "url";
  label: string;
  count: number | null;
  samples: string[];
  warning: string | null;
};

export type ManifestPreview = {
  manifest: {
    entries: ManifestEntry[];
    more: number;
    exclusions: string[];
    unsupported: string[];
    webUrls: string[];
    youtubeUrls: string[];
  };
  text: string;
};

export type MakeProjectArgs = {
  path: string;
  createAgentsMd: boolean;
  instructions?: string;
  description?: string;
  inclusions?: string[];
};

export interface ProjectClient {
  list(includeArchived?: boolean): Promise<ProjectDetail[]>;
  read(path: string): Promise<ProjectDetail>;
  create(request: NewProjectRequest): Promise<ProjectDetail>;
  make(args: MakeProjectArgs): Promise<ProjectDetail>;
  update(path: string, update: ProjectUpdate): Promise<ProjectDetail>;
  archive(path: string, archived: boolean): Promise<ProjectDetail>;
  inspectFolder(path: string): Promise<FolderInspection>;
  manifest(path: string): Promise<ManifestPreview>;
}

export function createProjectClient(): ProjectClient {
  return {
    list: (includeArchived = false) => call("agent_list_projects", { includeArchived }),
    read: (path) => call("agent_read_project", { path }),
    create: (r) =>
      call("agent_create_project", {
        name: r.name,
        parent: r.parent,
        description: r.description,
        inclusions: r.inclusions,
        instructions: r.instructions,
      }),
    make: (a) => call("agent_make_project", { ...a }),
    update: (path, update) => call("agent_update_project", { path, update }),
    archive: (path, archived) => call("agent_archive_project", { path, archived }),
    inspectFolder: (path) => call("agent_inspect_folder", { path }),
    manifest: (path) => call("agent_project_manifest", { path }),
  };
}

export const projectClient: ProjectClient = createProjectClient();
