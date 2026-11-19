---
name: writer-excalidraw
description: Draw diagrams as Excalidraw files in a Markdown vault with the `excalidraw:` commands of the `writer` CLI. Use when the user asks for a diagram, flowchart, architecture sketch, mind map or any drawing, or to change, look at or export one. Drawings are native `.excalidraw` files (existing `.excalidraw.md` drawings from Obsidian's Excalidraw plugin work too). Describe boxes and arrows in a small JSON spec; the commands place, size, connect and change them, and `preview` lets you see the result.
---

# Draw with Excalidraw

`excalidraw:create` makes a drawing from a spec of boxes and arrows, `excalidraw:add` extends it, `excalidraw:update` changes, moves, re-labels or removes what is there, `excalidraw:read` prints it back as a spec, `excalidraw:preview` renders it to an image you can look at, `excalidraw:export` writes an SVG or PNG next to it. All but `preview` and `export` edit the file directly, so they work with Writer closed. A drawing that is open in Writer reloads by itself and each new box and arrow is drawn in, so the user watches it grow. For the command grammar (`key=value`, quoting, exit codes) see the `writer-cli` skill.

## The loop

You cannot judge a diagram from its spec. Draw, look, fix, look again:

1. `create` the skeleton (the main path), or `add` to a drawing that exists. `read` first when the user made the drawing.
2. `preview`, then open the printed path with your image reader. Check for overlapping boxes, labels cut off or wrong, crowded arrows, and whether the kind of diagram reads at a glance.
3. `update` to fix what you saw (move, re-label, recolour, remove), or `add` more. Then `preview` again.
4. Stop when the picture is clear, not when the spec is long. Two or three rounds is normal.

`preview` needs Writer running with the vault open (exit 4, `Writer is not running`, otherwise); without it, `read` and trust the spec.

## Commands

```
writer excalidraw:create path=Diagrams/Arch.excalidraw spec='<json>'
writer excalidraw:add path=Diagrams/Arch.excalidraw spec='<json>'
writer excalidraw:update path=Diagrams/Arch.excalidraw spec='<json>'
writer excalidraw:read path=Diagrams/Arch.excalidraw
writer excalidraw:preview path=Diagrams/Arch.excalidraw [format=png|svg] [scale=2]
writer excalidraw:export path=Diagrams/Arch.excalidraw [format=svg|png]
```

- `path=` is exact from the vault root; `file=Arch` also works for an existing drawing. A new path without `.excalidraw` or `.excalidraw.md` gets `.excalidraw` (the native format); give `.excalidraw.md` only to match an Obsidian vault that keeps its drawings that way. `create` refuses to replace a file unless you add the `overwrite` flag.
- `preview` prints the absolute path of an image in the OS temp folder (never in the vault; old ones are cleaned up). `format` is `png` (default) or `svg`; `scale` (0.5 to 4, PNG only, default 1) makes small text easier to read, `scale=2` is a good start.
- `export` writes `<name>.svg` (default) or `<name>.png` beside the drawing in the vault and prints its vault-relative path. Use it when the user wants the image, not to look yourself.
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

- `nodes[]`: `id` (yours, unique, kept so later commands can address the box), `text` (the label), `shape` (`rectangle` default, `ellipse`, `diamond`, `text` for a label with no box), `x` and `y` (both or neither), `w` and `h` (a size; the text must fit), `color` (`blue`, `green`, `red`, `yellow`, `orange`, `purple`, `gray`, or `#rrggbb`).
- `edges[]`: `[from, to]` or `[from, to, label]` (or `{"from","to","label","color"}`) between node ids. Arrows run from the first to the second. In `add`, an id may name a box that is already in the drawing, so an `add` with only `edges` draws an arrow between two existing boxes.
- `groups[]`: `{ "nodes": [ids] }` moves and selects those boxes together. Only boxes added in the same call.
- `direction`: `LR` (default, layers run left to right) or `TB` (top to bottom).
- Boxes without `x` and `y` are placed for you in layers by their arrows, with room between them, nothing overlapping. In `add`, new boxes go below what is already drawn. Give `x` and `y` only when the position means something.

### Changing a drawing: `update`

`update` takes the same spec; every id must already be in the drawing (an unknown id is an error naming it, and nothing is written).

```spec update
{
  "nodes": [{ "id": "api", "text": "Gateway", "color": "green", "x": 400, "y": 120 }],
  "edges": [["api", "db", "writes"]]
}
```

and, to delete (here a box `cache` with its arrows, and the arrow `api -> queue`):

```json
{ "remove": { "nodes": ["cache"], "edges": [["api", "queue"]] } }
```

- `nodes[]` change the box with that `id`; only the fields you give change: `text` (`""` clears the label), `shape`, `color`, `x` and `y` (moves it; its arrows and their labels follow), `w` and `h`. A box grows to fit a longer label, never shrinks.
- `edges[]` address an arrow by `[from, to]` (every arrow from `from` to `to`): a label (`""` clears it) and, as an object, a `color`. They never create an arrow: use `add`.
- `remove.nodes` deletes boxes with their arrows; `remove.edges` deletes arrows `[from, to]` and keeps the boxes.
- What you do not name stays exactly as it was: the user's own boxes, freehand and images.

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
9. **Build in steps, then look.** Follow the loop above: skeleton, `preview`, fix with `update` or `add`, `preview` again. `export` only when the user wants the image file.
10. **Keep the user's drawing.** `add` never moves existing boxes, and `update` touches only what you name. Do not `create` over a file with `overwrite` unless asked.

Worked specs: [references/examples.md](references/examples.md). The example specs there are run by the Writer test suite, so each one builds a valid drawing.
