// The drawing tabs that are open, by path, so the exporter and the socket command can ask one to
// write its unsaved edits before they read the file.
export interface LiveView {
  /** Save now; resolves when the file holds what the canvas holds. */
  flush(): Promise<void>;
}

const views = new Map<string, LiveView>();

export function registerLiveView(path: string, view: LiveView): () => void {
  views.set(path, view);
  return () => {
    if (views.get(path) === view) views.delete(path);
  };
}

export async function flushLiveView(path: string): Promise<void> {
  await views.get(path)?.flush();
}
