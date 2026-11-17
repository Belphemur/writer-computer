import { useEffect, useRef } from "react";
import { PluginBrowser } from ".";
import {
  useClosePluginBrowser,
  useIsPluginBrowserOpen,
  useReconcilePlugins,
  useRequestPluginsTrust,
} from "../use-plugins";
import { useWorkspaceRoot } from "@/hooks/use-workspace";
import { pluginCatalogStore } from "../stores/plugin-store-catalog";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Full-window modal hosting the community-plugin marketplace. Opened from Settings and the
 *  command palette via the UI store; Escape and the backdrop close it. */
export function PluginBrowserDialog() {
  const root = useWorkspaceRoot();
  const isOpen = useIsPluginBrowserOpen();
  const close = useClosePluginBrowser();
  const requestTrust = useRequestPluginsTrust();
  const reconcile = useReconcilePlugins();
  const cardRef = useRef<HTMLDivElement>(null);

  // A workspace switch must not leave the previous vault's marketplace open.
  useEffect(() => {
    if (!root) close();
  }, [root, close]);

  useEffect(() => {
    if (!isOpen) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cardRef.current?.focus();
    // Capture phase so Escape wins over the window-level shortcut handler.
    const onKeyDown = (event: KeyboardEvent) => {
      const card = cardRef.current;
      if (!card) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === card)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      } else if (!card.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      previous?.focus();
    };
  }, [isOpen, close]);

  if (!isOpen || !root) return null;

  async function handleRequestTrust() {
    await requestTrust();
    await pluginCatalogStore.getState().refreshState();
  }

  return (
    <div
      className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center px-6 py-6"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={cardRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="plugin-browser-title"
        className="flex max-h-[calc(100vh-3rem)] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-[var(--line-subtler)] bg-[var(--surface-card)] outline-none"
      >
        <div className="flex items-center justify-between gap-4 px-5 py-3.5">
          <h2
            id="plugin-browser-title"
            className="text-[15px] font-semibold text-[var(--text-primary)]"
          >
            Browse community plugins
          </h2>
          <button
            type="button"
            className="rounded-lg border border-[var(--line-subtle)] px-3 py-1.5 text-[13px] text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-subtle-strong)] focus-visible:outline-2 focus-visible:outline-offset-2"
            onClick={close}
          >
            Close
          </button>
        </div>
        <div className="min-h-0 overflow-y-auto px-5 pb-5">
          <PluginBrowser
            onRequestTrust={() => void handleRequestTrust()}
            onPluginsChanged={() => void reconcile()}
          />
        </div>
      </div>
    </div>
  );
}
