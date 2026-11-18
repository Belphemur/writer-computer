import { definePageKind } from "./types";

/**
 * The diff of every note an agent chat changed, each against its first-touch version (ADR
 * 2026-11-18 "Show a chat's changed notes ..."). `chatId` names the chat whose list it shows;
 * `focus` is the note to scroll to. Transient like a plugin view: the diffs live in the backend's
 * memory, so the tab is not restored with the session. Its body is the agent feature's.
 */
export type SessionChangesLocation = {
  kind: "session-changes";
  chatId: string;
  focus?: string;
};

export const sessionChangesKind = definePageKind<"session-changes", SessionChangesLocation>({
  kind: "session-changes",
  title: () => "Session changes",
  description: "The notes an agent chat changed",
  loadsDocument: false,
  feature: "agent",
  fromPayload: () => null,
  serialize: () => null,
});
