// The public entry of the Tasks feature: what another feature may name. Bases toggles the
// checkbox of a task row through the service `tasks.rows` (`getService`) and takes the TYPES from
// here with `import type` (erased: no runtime edge between the features). Nothing else of this
// folder is a contract.

/** The service id, one of the manifest's `provides`. */
export const TASKS_ROWS = "tasks.rows";

export interface TaskToggleArgs {
  /** Vault-relative path of the note holding the task. */
  path: string;
  /** 1-based line of the task. */
  line: number;
  /** The description the caller listed: a changed line is refused instead of guessed. */
  expect?: string;
}

/** What a base's task rows can ask of the feature. */
export interface TasksRowsService {
  /** Toggle (or cycle, or complete with the next occurrence) one task in its note. */
  toggle(args: TaskToggleArgs): Promise<{ path: string; lines: number[] }>;
}
