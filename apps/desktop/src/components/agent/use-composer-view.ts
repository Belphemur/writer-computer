import { Compartment, EditorState, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { PillContext } from "@/lib/agent/pill";
import {
  composerExtensions,
  placeholderExtension,
  pillContextField,
  setPillContext,
  type ComposerExtras,
} from "./composer-extensions";

export type ComposerViewOptions = {
  /** The draft's text (the store owns it; the editor shows it). */
  text: string;
  pills: PillContext;
  disabled: boolean;
  placeholder: string;
  /** ARIA attributes of the editable element (the combobox state of the menu). */
  aria: Record<string, string>;
  /** Callbacks; read at event time, so they may close over the latest render. */
  handlers: ComposerExtras;
};

/** One CodeMirror view for the composer, created by a callback ref. The store's text is pushed
 *  into the editor only when it differs (history-free), so typing and IME never loop through
 *  React. `contentRef` is the focusable element. */
export function useComposerView(o: ComposerViewOptions) {
  const view = useRef<EditorView | null>(null);
  const contentRef = useRef<HTMLElement | null>(null);
  const latest = useRef(o);
  const [parts] = useState(() => ({
    placeholder: new Compartment(),
    editable: new Compartment(),
    attrs: new Compartment(),
  }));
  const dynamic = (x: ComposerViewOptions) => ({
    placeholder: placeholderExtension(x.placeholder),
    editable: [EditorView.editable.of(!x.disabled), EditorState.readOnly.of(x.disabled)],
    attrs: EditorView.contentAttributes.of({
      role: "textbox",
      "aria-multiline": "true",
      "aria-label": "Message the agent",
      "aria-disabled": String(x.disabled),
      ...x.aria,
    }),
  });

  useLayoutEffect(() => {
    latest.current = o;
  });

  const host = useCallback(
    (el: HTMLElement | null) => {
      if (!el) return;
      const cur = latest.current;
      const d = dynamic(cur);
      const h = {
        onKey: (e: KeyboardEvent) => latest.current.handlers.onKey(e),
        open: (t: string) => latest.current.handlers.open(t),
        onChange: (t: string, c: number, k: boolean) => latest.current.handlers.onChange(t, c, k),
        onCompositionStart: () => latest.current.handlers.onCompositionStart(),
        onCompositionEnd: () => latest.current.handlers.onCompositionEnd(),
        onImageFiles: (files: File[]) => latest.current.handlers.onImageFiles(files),
      };
      const v = new EditorView({
        parent: el,
        state: EditorState.create({
          doc: cur.text,
          extensions: [
            composerExtensions(h),
            parts.placeholder.of(d.placeholder),
            parts.editable.of(d.editable),
            parts.attrs.of(d.attrs),
          ],
        }),
      });
      v.dispatch({ effects: setPillContext.of(cur.pills) });
      view.current = v;
      contentRef.current = v.contentDOM;
      return () => {
        v.destroy();
        view.current = null;
        contentRef.current = null;
      };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `dynamic` only reads stable compartments
    [],
  );

  useLayoutEffect(() => {
    const v = view.current;
    if (!v || v.state.doc.toString() === o.text) return;
    v.dispatch({
      changes: { from: 0, to: v.state.doc.length, insert: o.text },
      selection: { anchor: o.text.length },
      annotations: Transaction.addToHistory.of(false),
    });
  }, [o.text]);

  useLayoutEffect(() => {
    const v = view.current;
    if (v && v.state.field(pillContextField) !== o.pills)
      v.dispatch({ effects: setPillContext.of(o.pills) });
  }, [o.pills]);

  const ariaKey = JSON.stringify(o.aria);
  useLayoutEffect(() => {
    const d = dynamic(o);
    view.current?.dispatch({
      effects: [
        parts.placeholder.reconfigure(d.placeholder),
        parts.editable.reconfigure(d.editable),
        parts.attrs.reconfigure(d.attrs),
      ],
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the values it reads
  }, [o.placeholder, o.disabled, ariaKey]);

  return { host, view: view as RefObject<EditorView | null>, contentRef };
}
