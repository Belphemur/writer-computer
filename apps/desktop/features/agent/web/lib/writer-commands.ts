/**
 * Writer's own slash commands: the one registry. A message that is exactly one of them (at the
 * start, optionally with arguments, as the CLI reads its own) is run by Writer and never sent to
 * Claude: no turn, no user card; the result is one transient notice line in the transcript.
 * The `/` menu lists these rows first, marked "Writer" (`slash-commands.ts`); the pill marks them
 * the same way (`pill.ts`). Adding a command is one entry in {@link WRITER_COMMANDS}.
 *
 * Writer's command wins over a skill or CLI command of the same name: the menu keeps the other row
 * (with its source) but sending runs the Writer one.
 */
import { backendOrDefault } from "./backends";
import { refusalText, NOTHING_TO_TITLE_TEXT, type RegenerateOutcome } from "./auto-title";
import type { ChatId } from "./events";
import type { Chat } from "./transcript";

export type WriterCommandContext = {
  chatId: ChatId;
  chat: Chat;
  /** Text after the command name, trimmed; "" when none. */
  args: string;
  /** The store's `regenerateChatTitle`, injected so this module stays pure. */
  regenerateTitle: (chatId: ChatId) => Promise<RegenerateOutcome>;
  /** The store's `reloadChatSession`: the notice to show now, or `null` when it started. */
  reloadSession: (chatId: ChatId) => Promise<string | null>;
};

export type WriterCommand = {
  /** Without the leading slash, lower case. */
  name: string;
  description: string;
  /** Runs locally; resolves to the one-line result shown in the transcript (errors included), or
   *  `null` when an event brings the notice. */
  run: (ctx: WriterCommandContext) => Promise<string | null>;
};

export const WRITER_COMMANDS: readonly WriterCommand[] = [
  {
    name: "regenerate-title",
    description: "Write a new title for this chat",
    async run({ chat, chatId, regenerateTitle }) {
      if (!chat.turns.some((t) => t.user)) return NOTHING_TO_TITLE_TEXT;
      try {
        const out = await regenerateTitle(chatId);
        return out.status === "done"
          ? `Title regenerated: ${out.summary.title}`
          : refusalText(out.reason, backendOrDefault(chat.backendId).product);
      } catch (e) {
        return `Could not regenerate the title: ${String(e)}`;
      }
    },
  },
  {
    name: "reload",
    description: "Restart this chat's session to pick up new skills and MCP servers",
    run: ({ chatId, reloadSession }) => reloadSession(chatId),
  },
];

export function findWriterCommand(name: string): WriterCommand | undefined {
  const n = name.toLowerCase();
  return WRITER_COMMANDS.find((c) => c.name === n);
}

const WHOLE_MESSAGE = /^\/([A-Za-z0-9][\w:.-]*)(?:\s+([\s\S]*))?$/;

/** The Writer command a whole message is, or null (an unknown `/foo` goes to Claude). */
export function parseWriterCommand(text: string): { command: WriterCommand; args: string } | null {
  const m = WHOLE_MESSAGE.exec(text.trim());
  const command = m && findWriterCommand(m[1]!);
  return command ? { command, args: (m[2] ?? "").trim() } : null;
}
