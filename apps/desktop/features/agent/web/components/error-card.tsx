import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Alert02Icon } from "@hugeicons/core-free-icons";
import { detectAgentBinary, retryAgent } from "@features/agent/web/hooks/agent-api";
import { backendOrDefault } from "@features/agent/web/lib/backends";
import { useSettingsStore } from "@/stores/settings-store";
import { openExternal } from "@/lib/link-activation";
import { copyRecentErrors } from "@/lib/log-actions";
import type { Chat } from "@features/agent/web/lib/transcript";
import { Ico } from "./agent-icon";

export function Button({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md border border-[var(--line-subtle)] px-2.5 py-1 text-[12.5px] hover:bg-[var(--item-hover-bg)]"
    >
      {children}
    </button>
  );
}

/** "Choose binary…": the picked program is detected first; only a program that is found becomes
 *  the backend's `binaryPath` setting (what the next start reads). Otherwise the card stays on
 *  "not found" and nothing is saved. The setting change makes every reader look again. */
export async function chooseBinary(backendId: string) {
  const backend = backendOrDefault(backendId);
  const picked = await openDialog({
    multiple: false,
    directory: false,
    title: `Choose the ${backend.program} binary`,
  });
  if (typeof picked !== "string") return;
  const found = await detectAgentBinary(backendId, picked);
  if (found?.found) await useSettingsStore.getState().setSetting(backend.keys.binaryPath, picked);
}

function resetText(resetsAt: number | null): string | null {
  return resetsAt
    ? `Resets at ${new Date(resetsAt * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`
    : null;
}

/** The fix action per error kind (spec 2, "Error cards"). Status is icon plus text, never colour alone. */
export function ErrorCard({ chat }: { chat: Chat }) {
  const err = chat.error;
  if (!err) return null;
  const backend = backendOrDefault(chat.backendId);
  let title = "Something went wrong";
  let body: string | null = err.message;
  let actions: React.ReactNode = null;
  switch (err.kind) {
    case "binary-not-found":
      title = `${backend.product} was not found`;
      body = `Writer could not find the \`${backend.program}\` program. Install ${backend.product}, or choose its location.`;
      actions = (
        <>
          <Button onClick={() => void chooseBinary(backend.id)}>Choose binary…</Button>
          {backend.installUrl && (
            <Button onClick={() => void openExternal(backend.installUrl!)}>
              Install {backend.product}
            </Button>
          )}
        </>
      );
      break;
    case "spawn-denied":
      title = `Writer was not allowed to start ${backend.label}`;
      actions = <Button onClick={() => void retryAgent()}>Ask again</Button>;
      break;
    case "auth":
      title = "Sign in required";
      body = backend.signIn.hint;
      actions = (
        <>
          <Button onClick={() => void writeText(backend.signIn.command)}>Copy command</Button>
          <Button onClick={() => void retryAgent()}>Retry</Button>
        </>
      );
      break;
    case "rate-limit":
      title = "Rate limit reached";
      body = [err.message, resetText(chat.rateLimit?.resetsAt ?? null)].filter(Boolean).join(" ");
      actions = <Button onClick={() => void retryAgent()}>Retry</Button>;
      break;
    case "protocol":
      title = `Unexpected response from ${backend.label}`;
      actions = <Button onClick={() => void copyRecentErrors()}>Copy diagnostics</Button>;
      break;
    default:
      title = err.kind === "timeout" ? `${backend.label} timed out` : "Something went wrong";
      if (err.retryable || err.kind === "unknown" || err.kind === "spawn-failed")
        actions = <Button onClick={() => void retryAgent()}>Retry</Button>;
  }
  return (
    <div
      role="alert"
      data-agent-error={err.kind}
      className="rounded-xl border border-[var(--agent-error)] bg-[var(--surface-card)] p-3 text-[13px]"
    >
      <div className="flex items-center gap-2 font-medium">
        <Ico icon={Alert02Icon} size={15} className="text-[var(--agent-error)]" />
        <span>{title}</span>
      </div>
      {body && <p className="mt-1 break-words text-text-secondary">{body}</p>}
      {actions && <div className="mt-2 flex flex-wrap gap-1.5">{actions}</div>}
    </div>
  );
}
