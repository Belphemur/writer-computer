export interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
  is_markdown: boolean;
  modified_at: number;
  /** Creation time in seconds; falls back to `modified_at` where the filesystem has none. */
  created_at: number;
  title: string | null;
  /** Vault-relative real path when the entry is a symlink followed inside the vault. */
  symlink_target?: string;
}

export interface FileContent {
  path: string;
  content: string;
  modified_at: number;
}

export interface WriteResult {
  path: string;
  modified_at: number;
}

export interface WorkspaceInfo {
  root: string;
  name: string;
  file_count: number;
  epoch: number;
}

export interface SearchResult {
  path: string;
  filename: string;
  relative_path: string;
  score: number;
  match_indices: number[];
  /** Display-title override (frontmatter `title`); matched like the file name. */
  title?: string | null;
}

export interface ContentSearchResult {
  path: string;
  line_number: number;
  line_content: string;
  match_ranges: [number, number][];
}
