// What the History tab shows of a file's versions, as pure functions of the rows Rust sends: who
// made each version (the label and badge), the days they group under and the bursts folded
// within a day (spec `SPECs/git-sync-spec.md` "History > List"). Nothing is hidden by a burst,
// only folded.
import { prettyModelId } from "@/lib/model-name";
import type { VersionRow } from "../ipc";

/** Consecutive versions of one author closer together than this are one burst. */
export const BURST_GAP_SECONDS = 15 * 60;

export type Badge = "agent" | "device" | "writer" | null;

export interface Label {
  badge: Badge;
  /** The device name, the agent's chat title, the message of a manual commit. */
  text: string;
  /** The agent that made it (`Claude`), for the badge. */
  agent?: string;
  /** Display names of the models (`Opus 5.5`), main agent first. */
  models: string[];
}

const capitalize = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** Who made the version: a device for the automatic commits, an agent badge and the chat title
 *  for an agent turn, Writer for its housekeeping, the message for a commit made outside Writer. */
export function labelOf(v: VersionRow): Label {
  if (v.type === "agent") {
    return {
      badge: "agent",
      text: v.subject,
      agent: v.agent ? capitalize(v.agent) : undefined,
      models: v.models.map(prettyModelId),
    };
  }
  if (v.type === "chore") return { badge: "writer", text: v.subject, models: [] };
  if (v.type === "user") {
    return {
      badge: "device",
      text: v.scope === "restore" ? `Restored ${v.subject}` : (v.device ?? "This device"),
      models: [],
    };
  }
  return { badge: null, text: v.subject, models: [] };
}

/** Versions of one author share a key: an agent chat, a device, a foreign commit by its message. */
export function authorKey(v: VersionRow): string {
  if (v.type === "agent") return `agent:${v.chat ?? v.subject}`;
  if (v.type === "user") return `device:${v.device ?? ""}`;
  if (v.type === "chore") return "writer";
  return `other:${v.subject}`;
}

export interface Burst {
  /** The newest version's id. */
  id: string;
  /** Newest first. One entry is a plain version. */
  versions: VersionRow[];
}

export interface DayGroup {
  key: string;
  label: string;
  bursts: Burst[];
}

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

export function dayLabel(seconds: number, now: Date = new Date()): string {
  const d = new Date(seconds * 1000);
  if (dayKey(d) === dayKey(now)) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (dayKey(d) === dayKey(yesterday)) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

export function timeLabel(seconds: number): string {
  return new Date(seconds * 1000).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** `14:02–14:32 · 6 saves` for a burst, the time for a single version. */
export function burstLabel(b: Burst): string {
  const newest = b.versions[0]!;
  if (b.versions.length === 1) return timeLabel(newest.time ?? 0);
  const oldest = b.versions[b.versions.length - 1]!;
  return `${timeLabel(oldest.time ?? 0)}–${timeLabel(newest.time ?? 0)} · ${b.versions.length} saves`;
}

/** The versions (newest first) grouped by day, then folded into bursts. */
export function groupVersions(versions: readonly VersionRow[], now: Date = new Date()): DayGroup[] {
  const days: DayGroup[] = [];
  for (const v of versions) {
    const time = v.time ?? 0;
    const d = new Date(time * 1000);
    let day = days[days.length - 1];
    if (!day || day.key !== dayKey(d)) {
      day = { key: dayKey(d), label: dayLabel(time, now), bursts: [] };
      days.push(day);
    }
    const burst = day.bursts[day.bursts.length - 1];
    const last = burst?.versions[burst.versions.length - 1];
    if (
      burst &&
      last &&
      authorKey(last) === authorKey(v) &&
      (last.time ?? 0) - time < BURST_GAP_SECONDS
    ) {
      burst.versions.push(v);
    } else {
      day.bursts.push({ id: v.rev, versions: [v] });
    }
  }
  return days;
}

/** `+3 −1`, or nothing when the counts are unknown (a binary file). */
export function countsLabel(v: Pick<VersionRow, "added" | "removed">): string | null {
  if (v.added == null || v.removed == null) return null;
  return `+${v.added} −${v.removed}`;
}

/** The name a path shows: the note's title, any other file with its extension. */
export function fileTitle(path: string): string {
  const name = path.split("/").pop() ?? path;
  return name.replace(/\.md$/i, "");
}
