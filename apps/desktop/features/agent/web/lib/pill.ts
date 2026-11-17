/**
 * The one definition of how a reference token (`@"Readable name"`, `@Plan`, `@activenote`,
 * `/skill`) looks as a pill: its label, tooltip, kind, tint and whether it resolves to something
 * attached. The composer (a CodeMirror widget) and the transcript (React) both render a pill by
 * calling {@link createPillElement} on the model {@link pillFor} returns, so a sent message and the
 * draft look the same. A pill is a VIEW of the token text; the document keeps the exact token.
 */
import { File02Icon, Folder01Icon } from "@hugeicons/core-free-icons";
import type { ContextRef } from "./events";
import { isActiveNoteToken, isTypedPath, refForToken } from "./mentions";
import { findWriterCommand } from "./writer-commands";
import { tokenizeMessage, type MessageSegment } from "./trigger";

export type PillKind = "note" | "folder" | "active-note" | "skill";

export type PillModel = {
  kind: PillKind;
  /** The token text exactly as it sits in the document. */
  raw: string;
  /** What the pill shows. */
  label: string;
  /** Tooltip: the full path, or why the pill is muted. */
  title: string;
  /** Vault-relative path a click opens (notes only). */
  target: string | null;
  /** False: nothing attached or known backs the token (shown muted). */
  resolved: boolean;
  /** True: an attached ref or a known skill backs the token, so it is a finished reference. A
   *  token that is merely path-shaped (resolved at send) or unbacked is text while it is typed. */
  attached: boolean;
  /** A Writer command at the start of the message (`writer-commands.ts`): Writer runs it, Claude
   *  never sees it. Marked "Writer" on the pill. */
  writer?: boolean;
};

export type PillContext = {
  /** Refs attached to the message (the active note's ref included). */
  refs: readonly ContextRef[];
  /** Known skill and command names, lower case; undefined: do not judge `/` tokens. */
  skills?: ReadonlySet<string>;
};

type TokenSegment = Extract<MessageSegment, { kind: "mention" | "slash" }>;

const nameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1).replace(/\.md$/i, "");

export function pillFor(seg: TokenSegment, ctx: PillContext): PillModel {
  if (seg.kind === "slash") {
    if (seg.atStart && findWriterCommand(seg.name))
      return {
        kind: "skill",
        raw: seg.raw,
        label: seg.raw,
        title: "Writer command: runs in Writer, not sent to Claude",
        target: null,
        resolved: true,
        attached: true,
        writer: true,
      };
    const resolved = !ctx.skills || ctx.skills.has(seg.name.toLowerCase());
    return {
      kind: "skill",
      raw: seg.raw,
      label: seg.raw,
      title: resolved ? "Skill" : "Unknown command",
      target: null,
      resolved,
      attached: resolved && ctx.skills !== undefined,
    };
  }
  if (isActiveNoteToken(seg)) {
    const ref = ctx.refs.find((r) => r.kind === "active-note");
    return {
      kind: "active-note",
      raw: seg.raw,
      label: ref ? nameOf(ref.path) : "Active note",
      title: ref ? `Active note: ${ref.path}` : "No note is open",
      target: ref ? ref.path : null,
      resolved: ref !== undefined,
      attached: ref !== undefined,
    };
  }
  const ref = refForToken(seg.path, ctx.refs);
  if (ref)
    return {
      kind: ref.kind,
      raw: seg.raw,
      label: ref.label ?? nameOf(ref.path),
      title: ref.path,
      target: ref.kind === "note" ? ref.path : null,
      resolved: true,
      attached: true,
    };
  if (isTypedPath(seg.path)) {
    // A typed path resolves (or stays literal) at send; an extension makes it a note.
    const note = /\.[^/.]+$/.test(seg.path.slice(seg.path.lastIndexOf("/") + 1));
    return {
      kind: note ? "note" : "folder",
      raw: seg.raw,
      label: nameOf(seg.path.replace(/\/$/, "")),
      title: seg.path,
      target: note ? seg.path : null,
      resolved: true,
      attached: false,
    };
  }
  return {
    kind: "note",
    raw: seg.raw,
    label: seg.path,
    title: "Not attached: pick a note from the menu",
    target: null,
    resolved: false,
    attached: false,
  };
}

export type PillRange = { from: number; to: number; model: PillModel };

/** Every token of `text` as a pill with its document range (tokens never span lines). */
export function pillRanges(text: string, ctx: PillContext): PillRange[] {
  const out: PillRange[] = [];
  let at = 0;
  for (const seg of tokenizeMessage(text)) {
    const len = seg.kind === "text" ? seg.text.length : seg.raw.length;
    if (seg.kind !== "text") out.push({ from: at, to: at + len, model: pillFor(seg, ctx) });
    at += len;
  }
  return out;
}

export function pillAriaLabel(m: PillModel): string {
  const what = m.writer
    ? "Writer command"
    : m.kind === "skill"
      ? "Skill"
      : m.kind === "folder"
        ? "Folder"
        : m.kind === "active-note"
          ? "Active note"
          : "Note";
  return `${what}: ${m.label}${m.resolved ? "" : " (not attached)"}`;
}

export const samePill = (a: PillModel, b: PillModel) =>
  a.kind === b.kind &&
  a.raw === b.raw &&
  a.label === b.label &&
  a.title === b.title &&
  a.target === b.target &&
  a.resolved === b.resolved &&
  a.attached === b.attached &&
  a.writer === b.writer;

type IconData = readonly (readonly [string, Record<string, string | number>])[];
const ICONS: Record<PillKind, IconData | null> = {
  note: File02Icon as IconData,
  "active-note": File02Icon as IconData,
  folder: Folder01Icon as IconData,
  skill: null, // the slash in the label is its icon
};

const SVG_NS = "http://www.w3.org/2000/svg";

function createIcon(doc: Document, icon: IconData): SVGElement {
  const svg = doc.createElementNS(SVG_NS, "svg");
  for (const [k, v] of Object.entries({
    viewBox: "0 0 24 24",
    width: "12",
    height: "12",
    fill: "none",
    "aria-hidden": "true",
  }))
    svg.setAttribute(k, v);
  svg.classList.add("agent-pill-icon");
  for (const [tag, attrs] of icon) {
    const el = doc.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs))
      if (k !== "key")
        el.setAttribute(
          k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`),
          `${v}`,
        );
    svg.appendChild(el);
  }
  return svg;
}

/** The pill DOM, styled by `.agent-pill` in App.css (design tokens, one tint per kind, muted when
 *  unresolved). `as: "button"` is a clickable pill (transcript); `span` is inert (composer, where
 *  the editor owns clicks). */
export function createPillElement(
  model: PillModel,
  { as = "span", doc = document }: { as?: "span" | "button"; doc?: Document } = {},
): HTMLElement {
  const el = doc.createElement(as);
  el.className = "agent-pill";
  el.dataset.agentToken = model.kind === "skill" ? "skill" : "mention";
  el.dataset.pillKind = model.kind;
  el.dataset.resolved = String(model.resolved);
  if (model.target) el.dataset.target = model.target;
  el.title = model.title;
  el.setAttribute("aria-label", pillAriaLabel(model));
  if (as === "button") (el as HTMLButtonElement).type = "button";
  else el.setAttribute("role", "img");
  const icon = ICONS[model.kind];
  if (icon) el.appendChild(createIcon(doc, icon));
  const label = doc.createElement("span");
  label.className = "agent-pill-label";
  label.textContent = model.label;
  el.appendChild(label);
  if (model.writer) {
    el.dataset.pillWriter = "true";
    const mark = doc.createElement("span");
    mark.className = "agent-pill-mark";
    mark.textContent = "Writer";
    el.appendChild(mark);
  }
  return el;
}
