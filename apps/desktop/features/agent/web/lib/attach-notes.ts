// Attaches notes to the active chat's draft the way picking them from `@` does: the readable name
// goes into the text as a mention token and the ref into the draft's mentions (refs follow the
// text, `draft-refs.ts`), so the user sees the pills and can edit before sending.
import { noteLabel } from "@/lib/note-title";
import { openAgentPane } from "@features/agent/web/hooks/agent-api";
import { useAgentStore } from "@features/agent/web/stores/agent-store";
import { mentionToken, pickLabel, toContextRef } from "./mentions";

export function attachNotesToDraft(paths: readonly string[]): void {
  const store = useAgentStore.getState();
  if (store.activeChatId === null) store.newChat();
  openAgentPane();
  const chatId = useAgentStore.getState().activeChatId;
  if (chatId === null) return;
  const draft = useAgentStore.getState().drafts[chatId] ?? {
    text: "",
    mentions: [],
    activeNote: true,
  };
  let text = draft.text;
  const mentions = [...draft.mentions];
  for (const path of paths) {
    if (mentions.some((m) => m.kind === "note" && m.path === path)) continue;
    const candidate = {
      kind: "note" as const,
      path,
      label: noteLabel(path).text,
      detail: path,
    };
    const label = pickLabel(candidate, mentions);
    mentions.push(toContextRef(candidate, label));
    text += `${text === "" || text.endsWith(" ") ? "" : " "}${mentionToken(label)} `;
  }
  store.setDraft(chatId, { text, mentions });
}
