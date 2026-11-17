import { parse } from "yaml";

const FRONTMATTER_RE = /^---\n([\s\S]*?\n)?---(?:\n|$)/;

/** A note's title is its file name; only a non-empty frontmatter `title` overrides it (never the H1). */
export type TitleSource = "frontmatter" | "none";

export interface ParsedFile {
  frontmatter: string | null;
  body: string;
}

export interface ParsedDocument extends ParsedFile {
  title: string;
  titleSource: TitleSource;
}

export function parseFrontmatter(raw: string): ParsedFile {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) return { frontmatter: null, body: raw };
  // Group captures content including trailing \n; strip it. Undefined = empty frontmatter.
  const fm = match[1] ? match[1].replace(/\n$/, "") : "";
  return { frontmatter: fm, body: raw.slice(match[0].length) };
}

export function serializeFile(frontmatter: string | null, body: string): string {
  if (frontmatter === null) return body;
  return `---\n${frontmatter}\n---\n${body}`;
}

export function parseDocument(raw: string): ParsedDocument {
  const parsed = parseFrontmatter(raw);
  const { title, titleSource } = inferTitle(parsed.frontmatter);

  return {
    frontmatter: parsed.frontmatter,
    body: parsed.body,
    title,
    titleSource,
  };
}

/**
 * The explicit display-title override (frontmatter `title`), or `""` when the note has none and
 * shows its file name. The first heading is never a title.
 */
export function inferTitle(frontmatter: string | null): {
  title: string;
  titleSource: TitleSource;
} {
  const frontmatterTitle = getFrontmatterTitle(frontmatter);
  if (frontmatterTitle !== null) {
    return { title: frontmatterTitle, titleSource: "frontmatter" };
  }
  return { title: "", titleSource: "none" };
}

export function serializeDocument(frontmatter: string | null, body: string): string {
  return serializeFile(frontmatter, body);
}

const displayDateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "long",
  day: "numeric",
  year: "numeric",
});

export function getFrontmatterDisplayDate(frontmatter: string | null): string | null {
  const parsed = parseFrontmatterObject(frontmatter);
  if (parsed === null) return null;

  for (const key of ["date", "updated"]) {
    const formatted = formatFrontmatterDateValue(parsed[key]);
    if (formatted !== null) return formatted;
  }

  return null;
}

function parseFrontmatterObject(frontmatter: string | null): Record<string, unknown> | null {
  if (frontmatter === null || frontmatter.trim() === "") return {};

  let parsed: unknown;
  try {
    parsed = parse(frontmatter, { logLevel: "error" });
  } catch {
    return null;
  }

  if (
    parsed === null ||
    parsed === undefined ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    return null;
  }

  return parsed as Record<string, unknown>;
}

function getFrontmatterTitle(frontmatter: string | null): string | null {
  const parsed = parseFrontmatterObject(frontmatter);
  if (parsed === null) return null;

  const title = parsed.title;
  if (typeof title !== "string") return null;

  const normalized = title.trim();
  return normalized === "" ? null : normalized;
}

function formatFrontmatterDateValue(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.valueOf()) ? null : displayDateFormatter.format(value);
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;

    const timestamp = Date.parse(trimmed);
    if (Number.isNaN(timestamp)) return trimmed;
    return displayDateFormatter.format(new Date(timestamp));
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value > 1_000_000_000_000 ? value : value * 1000);
    return Number.isNaN(date.valueOf()) ? null : displayDateFormatter.format(date);
  }

  return null;
}
