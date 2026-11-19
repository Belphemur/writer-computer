import { createPortal } from "react-dom";
import { NOTICE_Z } from "@/lib/popup-layer";
import { dismissEditorNotice, useEditorNoticeStore } from "./editor-notice-store";

/** The one app notice (toast): bottom centre of the window, above every layer (modals, plugin
 *  popups), portalled to the body so no frame clips it or hides it under the tab strip. */
export function EditorNoticeBanner() {
  const message = useEditorNoticeStore((s) => s.message);
  // the live region stays mounted so a screen reader announces the notice when it appears
  return createPortal(
    <div role="status" aria-live="polite" data-app-notice className="contents">
      {message && (
        <button
          type="button"
          onClick={dismissEditorNotice}
          className="pointer-events-auto fixed bottom-6 left-1/2 max-w-[min(90vw,560px)] -translate-x-1/2 cursor-pointer rounded-lg border-0 px-3 py-2 text-left text-[13px]"
          style={{
            zIndex: NOTICE_Z,
            background: "var(--bg-base)",
            border: "1px solid var(--line-subtler)",
            boxShadow: "0 8px 24px rgba(0, 0, 0, 0.28)",
            color: "var(--text-primary)",
            letterSpacing: "-0.01em",
          }}
        >
          {message}
        </button>
      )}
    </div>,
    document.body,
  );
}
