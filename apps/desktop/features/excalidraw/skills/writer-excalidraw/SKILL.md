---
name: writer-excalidraw
description: Draw diagrams as Excalidraw files in a Markdown vault with the `excalidraw:` commands of the `writer` CLI. Use when the user asks for a diagram, flowchart, architecture sketch, mind map or any drawing, or to change or export one. Drawings are `.excalidraw.md` files that open in Writer and in Obsidian's Excalidraw plugin. Describe boxes and arrows in a small JSON spec; the commands place, size and connect them.
---

# Draw with Excalidraw

`writer excalidraw:create` makes a drawing from a spec of boxes and arrows, `excalidraw:add` and `excalidraw:connect` extend it, `excalidraw:read` prints it back as a spec, `excalidraw:export` writes an SVG. They edit the file directly, so they work with Writer closed (except `export`). A drawing that is open in Writer reloads by itself and each new box and arrow is drawn in, so build in steps and the user watches it grow. For the command grammar (`key=value`, quoting, exit codes) see the `writer-cli` skill.

## Commands

```
writer excalidraw:create path=Diagrams/Arch.excalidraw.md spec='<json>'
writer excalidraw:add path=Diagrams/Arch.excalidraw.md spec='<json>'
writer excalidraw:connect path=Diagrams/Arch.excalidraw.md from=api to=db label=reads
writer excalidraw:read path=Diagrams/Arch.excalidraw.md
writer excalidraw:export path=Diagrams/Arch.excalidraw.md
```

- `path=` is exact from the vault root; `file=Arch` also works for an existing drawing. A new path without `.excalidraw.md` or `.excalidraw` gets `.excalidraw.md`. `create` refuses to replace a file unless you add the `overwrite` flag.
- `export` needs Writer running with the vault open (exit 4, `Writer is not running`, otherwise) and prints the vault-relative path of the SVG it wrote next to the drawing.
- Quote the spec with single quotes in the shell; `\n` inside a text value is a line break.

## The spec

```spec
{
  "direction": "LR",
  "nodes": [
    { "id": "api", "text": "API", "color": "blue" },
    { "id": "db", "text": "Database", "shape": "ellipse" }
  ],
  "edges": [["api", "db", "reads"]],
  "groups": [{ "nodes": ["api", "db"] }]
}
```

- `nodes[]`: `id` (yours, unique, kept so later commands can address the box), `text` (the label), `shape` (`rectangle` default, `ellipse`, `diamond`, `text` for a label with no box), `x` and `y` (both or neither), `color` (`blue`, `green`, `red`, `yellow`, `orange`, `purple`, `gray`, or `#rrggbb`).
- `edges[]`: `[from, to]` or `[from, to, label]` between node ids. Arrows run from the first to the second. In `add` and `connect`, an id may name a box that is already in the drawing.
- `groups[]`: `{ "nodes": [ids] }` moves and selects those boxes together. Only boxes added in the same call.
- `direction`: `LR` (default, layers run left to right) or `TB` (top to bottom).
- Boxes without `x` and `y` are placed for you in layers by their arrows, with room between them, nothing overlapping. In `add`, new boxes go below what is already drawn. Give `x` and `y` only when the position means something.

`read` prints the same shape, with each box's `x`, `y`, `w`, `h`, and an `other` count for what a spec cannot express (freehand, images). Read before you change a drawing the user made.

## Draw well

1. **Pick the kind first.** A flow (steps with decisions), an architecture (parts and what talks to what), lanes (who does what, one group per actor), a mind map (one centre, branches), a comparison (two or three groups side by side). Say which in one line before you draw.
2. **One idea per box, short labels.** Two to four words. A sentence belongs in the note, not on the canvas.
3. **One direction.** `LR` for pipelines and timelines, `TB` for hierarchies and decision flows. Never both in one drawing.
4. **Few boxes.** Past about twelve, split into two drawings and link them in the note.
5. **A small palette with meaning.** One accent colour for what the reader should look at, `gray` for context, a second colour only for a second kind of thing. Colour never carries meaning alone: the label does too.
6. **Group what belongs together.** Boxes in one group move together; use it for a layer, a service boundary or a lane.
7. **Label an arrow only when the verb matters** ("reads", "publishes", "yes"/"no" out of a diamond). An unlabelled arrow means "leads to".
8. **Shapes mean something.** Rectangles are things, ellipses are start and end or external actors, diamonds are decisions, `text` is a title or a note.
9. **Build in steps, then look.** `create` the skeleton (the main path), then `add` the branches and `connect` the cross links. `read` it back to check ids and arrows. If the user wants an image, `export`.
10. **Keep the user's drawing.** `add` and `connect` never move existing boxes. Do not `create` over a file with `overwrite` unless asked.

Worked specs: [references/examples.md](references/examples.md). The example specs there are run by the Writer test suite, so each one builds a valid drawing.
