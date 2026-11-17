// Synthetic fixture plugins (no third-party code). Each registers CodeMirror extensions in a
// different "shape" real community plugins use. Written into a scratch vault by setup.mjs.
const COMMON = `
const { Plugin } = require("obsidian");
const { ViewPlugin, EditorView, Decoration } = require("@codemirror/view");
const { StateField, Facet, RangeSetBuilder } = require("@codemirror/state");
const language = require("@codemirror/language");
`;

module.exports = {
  // ViewPlugin walking the syntax tree + tokenClassNodeProp, a StateField, a Facet.
  "fx-good": `${COMMON}
const f = Facet.define({ combine: (v) => v.length });
const field = StateField.define({ create: () => 0, update: (v, tr) => v + (tr.docChanged ? 1 : 0) });
const vp = ViewPlugin.fromClass(class {
  constructor(view) { this.n = 0; this.walk(view); }
  update(u) { this.walk(u.view); }
  walk(view) {
    language.syntaxTree(view.state).iterate({ enter: (node) => { void node.type.prop(language.tokenClassNodeProp); this.n++; } });
    window.__fxGoodWalks = (window.__fxGoodWalks || 0) + 1;
  }
});
module.exports = class extends Plugin {
  onload() { this.registerEditorExtension([vp, field, f.of(1), EditorView.theme({})]); }
};`,
  // ViewPlugin that throws on every update (and one that throws in its constructor).
  "fx-throw-update": `${COMMON}
const vp = ViewPlugin.fromClass(class { constructor() {} update() { throw new Error("fx update boom"); } });
const vp2 = ViewPlugin.fromClass(class { constructor() { throw new Error("fx ctor boom"); } });
module.exports = class extends Plugin { onload() { this.registerEditorExtension([vp, vp2]); } };`,
  // StateField whose create throws: rejected at reconfigure.
  "fx-bad-field": `${COMMON}
const field = StateField.define({ create: () => { throw new Error("fx field boom"); }, update: (v) => v });
module.exports = class extends Plugin { onload() { this.registerEditorExtension(field); } };`,
  // decorations facet source that throws when the view reads it.
  "fx-bad-deco": `${COMMON}
module.exports = class extends Plugin {
  onload() { this.registerEditorExtension(EditorView.decorations.of(() => { throw new Error("fx deco boom"); })); }
};`,
  // not an extension at all
  "fx-invalid": `${COMMON}
module.exports = class extends Plugin { onload() { this.registerEditorExtension({ nope: 1 }); } };`,
  // a decorations provider returning a bad (non-RangeSet) value
  "fx-bad-deco-value": `${COMMON}
module.exports = class extends Plugin {
  onload() { this.registerEditorExtension(EditorView.decorations.of(() => ({ not: "a rangeset" }))); }
};`,
  // a higher-precedence extension that supplies its own (non-markdown) language
  "fx-lang-override": `${COMMON}
const { StreamLanguage } = language;
const { Prec } = require("@codemirror/state");
const plain = StreamLanguage.define({ token(stream) { stream.skipToEnd(); return null; } });
module.exports = class extends Plugin {
  onload() { this.registerEditorExtension(Prec.highest(plain)); }
};`,
  // dispatches a top-level appendConfig carrying a language, like plugins driving editor.cm
  "fx-append-lang": `${COMMON}
const { StateEffect } = require("@codemirror/state");
const plain = language.StreamLanguage.define({ token(stream) { stream.skipToEnd(); return null; } });
const poke = () => { const c = document.querySelector(".cm-content"); const v = c && c.cmTile && c.cmTile.root.view; if (v) v.dispatch({ effects: StateEffect.appendConfig.of(plain) }); };
module.exports = class extends Plugin {
  onload() { this.registerInterval(window.setInterval(poke, 1500)); }
};`,
  // dispatches a full top-level reconfigure replacing the whole config
  "fx-reconfigure": `${COMMON}
const { StateEffect } = require("@codemirror/state");
const poke = () => { const c = document.querySelector(".cm-content"); const v = c && c.cmTile && c.cmTile.root.view; if (v) v.dispatch({ effects: StateEffect.reconfigure.of([]) }); };
module.exports = class extends Plugin {
  onload() { this.registerInterval(window.setInterval(poke, 1500)); }
};`,
};
