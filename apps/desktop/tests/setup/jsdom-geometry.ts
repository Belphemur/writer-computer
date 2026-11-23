// Vitest setup file (vite.config.ts `test.setupFiles`), run before every test file. jsdom has no
// layout: CodeMirror measures text through Range rects, which jsdom lacks, so a measure pass that
// lands after a test ends raises an unhandled error and fails the whole run. The default
// environment is node (no Range), where this does nothing.
if (typeof Range !== "undefined") {
  if (!Range.prototype.getClientRects) {
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  }
  if (!Range.prototype.getBoundingClientRect) {
    Range.prototype.getBoundingClientRect = () =>
      ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }) as DOMRect;
  }
}
