---
name: writer-excalidraw
description: Draw diagrams as Excalidraw files in a Markdown vault with the `excalidraw:` commands of the `writer` CLI. Use when the user asks for a diagram, flowchart, architecture sketch, mind map or any drawing, or to change, look at or export one. Drawings are native `.excalidraw` files (existing `.excalidraw.md` drawings from Obsidian's Excalidraw plugin work too). Describe boxes and arrows in a small JSON spec; the commands place, size, connect and change them, and `preview` lets you see the result.
---

# Draw with Excalidraw

`excalidraw:create` makes a drawing from a spec of boxes, arrows, zones and a legend, `excalidraw:add` extends it, `excalidraw:update` changes, moves, restyles, re-labels or removes what is there, `excalidraw:read` prints it back as the spec `create` takes, `excalidraw:lint` finds layout faults, `excalidraw:preview` renders it to an image you can look at, `excalidraw:export` writes an SVG or PNG next to it. All but `preview` and `export` edit the file directly, so they work with Writer closed. A drawing that is open in Writer reloads by itself and each new box and arrow is drawn in, so the user watches it grow. For the command grammar (`key=value`, quoting, exit codes) see the `writer-cli` skill.

## The loop

You cannot judge a diagram from its spec. Draw, look, fix, look again:

1. `create` the skeleton (the main path), or `add` to a drawing that exists. `read` first when the user made the drawing. Run it once with the `check` flag first when the spec is long: it lists every problem and writes nothing.
2. `lint` until it is clean (it needs no app), then `preview` and open the printed path with your image reader. Check for overlapping boxes, labels cut off or wrong, crowded arrows, and whether the kind of diagram reads at a glance.
3. `update` to fix what you or `lint` saw (move, re-label, recolour, remove), or `add` more. Then `preview` again.
4. Stop when the picture is clear, not when the spec is long. Two or three rounds is normal.

`preview` needs Writer running with the vault open (exit 4, `Writer is not running`, otherwise); without it, `read` and trust the spec.

## Commands

```
writer excalidraw:create path=Diagrams/Arch.excalidraw spec='<json>'
writer excalidraw:add path=Diagrams/Arch.excalidraw spec='<json>'
writer excalidraw:update path=Diagrams/Arch.excalidraw spec='<json>'
writer excalidraw:read path=Diagrams/Arch.excalidraw [format=json]
writer excalidraw:lint path=Diagrams/Arch.excalidraw [format=text]
writer excalidraw:preview path=Diagrams/Arch.excalidraw [format=png|svg] [scale=2]
writer excalidraw:export path=Diagrams/Arch.excalidraw [format=svg|png]
```

- `path=` is exact from the vault root; `file=Arch` also works for an existing drawing. A new path without `.excalidraw` or `.excalidraw.md` gets `.excalidraw` (the native format); give `.excalidraw.md` only to match an Obsidian vault that keeps its drawings that way. `create` refuses to replace a file unless you add the `overwrite` flag.
- `preview` prints the absolute path of an image in the OS temp folder (never in the vault; old ones are cleaned up). `format` is `png` (default) or `svg`; `scale` (0.5 to 4, PNG only, default 1) makes small text easier to read, `scale=2` is a good start.
- `export` writes `<name>.svg` (default) or `<name>.png` beside the drawing in the vault and prints its vault-relative path. Use it when the user wants the image, not to look yourself.
- `spec=` is the JSON itself, `spec=@Specs/arch.json` (a file in the vault) or `spec=-` (standard input: `writer excalidraw:create path=A spec=- < spec.json`). For anything longer than a few boxes write the spec to a file and use `@`. The JSON reaches the parser as written, so `\n` inside a text value is JSON's own line break, no extra escaping.
- `check` (a flag on `create`, `add` and `update`) validates the whole spec, lists every invalid item and every text that overflows its box, notes layout faults of the result, and writes nothing. A normal run also reports all problems at once and writes nothing when there is one.
- `read` prints exactly what `create` accepts (positions and sizes included): `read` then `create path=Copy.excalidraw spec=@that.json` gives the same drawing. `format=json` wraps it as `{path, title, links, spec}`, `links` being the notes the boxes link to.
- `lint` prints JSON `{path, clean, findings:[{kind, ids, message}]}` (or lines with `format=text`) and never writes. Kinds: `label-over-label`, `label-over-box`, `arrow-through-box` (an arrow crossing a box it does not connect), `text-overflow`, `zone-contains-box` (a box inside a zone it is not a member of). `ids` are your node ids; an arrow is `from->to`.

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

- `nodes[]`: `id` (yours, unique, kept so later commands can address the box), `text` (the label), `shape` (`rectangle` default, `ellipse`, `diamond`, `text` for a label with no box), `x` and `y` (both or neither), `w` and `h` (a size), `color` (`blue`, `green`, `red`, `yellow`, `orange`, `purple`, `gray`, or `#rrggbb`: outline and fill together), `fill` and `stroke` (set the fill or the outline and text colour alone, a palette name or `#rrggbb`; `fill` may be `transparent`), `fontSize`, `strokeStyle` (`solid`, `dashed`, `dotted`), `link` (`"[[Note]]"` or a URL: the box opens it, and the drawing then counts as linking that note, so backlinks and the graph show it).
- Text wraps at the box's `w` when you give one (an error names the size it needs if a word or `h` cannot fit); without `w` the box grows to fit up to about 310 px of text, then wraps.
- `edges[]`: `[from, to]` or `[from, to, label]`, or an object `{"from","to","label","style","color","bidirectional","labelAt","fromSide","toSide","route"}`: `style` `solid` (default), `dashed` (planned or optional) or `dotted`; `color` as for a box; `bidirectional: true` puts a head at both ends (one arrow per pair); `labelAt` 0 to 1 slides the label along the arrow (default the middle); `fromSide` and `toSide` (`top`, `right`, `bottom`, `left`) choose where the arrow leaves and enters; `route` `straight` (default) or `elbow` (right angles). Arrows run from the first to the second. In `add`, an id may name a box that is already in the drawing, so an `add` with only `edges` draws an arrow between two existing boxes.
- `zones[]`: `{"id","label","nodes":[ids],"color","padding"}`: a titled area around those boxes (an Excalidraw frame, label top-left, outline `color`, default `padding` 40). A box is in one zone; zones do not nest. Leave room between zones: give boxes positions that cluster by zone, since automatic layout does not yet keep zones apart.
- `legend[]`: text lines laid out under the drawing (colours, scope, open items, sources). `read` gives them back as a list.
- `groups[]`: `{ "nodes": [ids] }` moves and selects those boxes together. Only boxes added in the same call.
- `direction`: `LR` (default, layers run left to right) or `TB` (top to bottom).
- Boxes without `x` and `y` are placed for you in layers by their arrows, with room between them, nothing overlapping. In `add`, new boxes go below what is already drawn. Give `x` and `y` only when the position means something.

```spec
{
  "nodes": [
    { "id": "web", "text": "Web app", "x": 0, "y": 0, "w": 160, "color": "blue", "link": "[[Web app]]" },
    { "id": "api", "text": "Public API", "x": 320, "y": 0, "fill": "yellow", "strokeStyle": "dashed" },
    { "id": "db", "text": "Database", "shape": "ellipse", "x": 640, "y": 0 }
  ],
  "edges": [
    ["web", "api", "https"],
    { "from": "api", "to": "db", "style": "dotted", "bidirectional": true, "route": "elbow", "fromSide": "right", "toSide": "left" }
  ],
  "zones": [{ "id": "backend", "label": "Backend", "nodes": ["api", "db"], "color": "orange" }],
  "legend": ["Dotted: planned", "Open: who owns the database?"]
}
```

### Changing a drawing: `update`

`update` takes the same spec; every id must already be in the drawing (an unknown id is an error naming it, and nothing is written).

```spec update
{
  "nodes": [{ "id": "api", "text": "Gateway", "color": "green", "x": 400, "y": 120 }],
  "edges": [["api", "db", "writes"]],
  "zones": [{ "id": "backend", "label": "Core services" }]
}
```

and, to delete (here a box `cache` with its arrows, and the arrow `api -> queue`):

```json
{ "remove": { "nodes": ["cache"], "edges": [["api", "queue"]] } }
```

- `nodes[]` change the box with that `id`; only the fields you give change: `text` (`""` clears the label), `shape`, `color`, `fill`, `stroke`, `fontSize`, `strokeStyle`, `link` (`""` removes it), `x` and `y` (moves it; its arrows and their labels follow), `w` and `h`. A box grows to fit a longer label, never shrinks.
- `edges[]` address an arrow by `[from, to]` (every arrow from `from` to `to`): a label (`""` clears it) and, as an object, `color`, `style`, `bidirectional`, `labelAt`, `route`, `fromSide`, `toSide`. They never create an arrow: use `add`.
- `zones[]` change a zone by `id`: `label`, `color`, `padding`, and `nodes` (the new member list: boxes join or leave, the frame resizes). An unknown zone id with `nodes` makes a new zone. A box moved or grown inside a zone refits the zone.
- `remove.nodes` deletes boxes with their arrows; `remove.edges` deletes arrows `[from, to]` and keeps the boxes; `remove.zones` deletes the frame and keeps its boxes.
- `update` takes no `direction`, `groups` or `legend` (use `add` for more legend lines).
- What you do not name stays exactly as it was: the user's own boxes, freehand and images.

`read` prints the same shape, with each box's `x`, `y`, `w`, `h`, the zones, the legend, and an `other` count for what a spec cannot express (freehand, images, arrows with a free end; `create` ignores it). Read before you change a drawing the user made.

For a whole diagram workflow (research the vault first, model zones and edges, lay out, lint, preview, link the drawing from its notes) see the `writer-diagram` skill.

## Draw well

1. **Pick the kind first.** A flow (steps with decisions), an architecture (parts and what talks to what), lanes (who does what, one group per actor), a mind map (one centre, branches), a comparison (two or three groups side by side). Say which in one line before you draw.
2. **One idea per box, short labels.** Two to four words. A sentence belongs in the note, not on the canvas.
3. **One direction.** `LR` for pipelines and timelines, `TB` for hierarchies and decision flows. Never both in one drawing.
4. **Few boxes.** Past about twelve, split into two drawings and link them in the note.
5. **A small palette with meaning.** One accent colour for what the reader should look at, `gray` for context, a second colour only for a second kind of thing. Colour never carries meaning alone: the label does too.
6. **Group what belongs together.** Boxes in one group move together; a zone draws a titled area around them: use it for a layer, a service boundary or a lane.
7. **Label an arrow only when the verb matters** ("reads", "publishes", "yes"/"no" out of a diamond). An unlabelled arrow means "leads to".
8. **Shapes mean something.** Rectangles are things, ellipses are start and end or external actors, diamonds are decisions, `text` is a title or a note.
9. **Build in steps, then look.** Follow the loop above: skeleton, `preview`, fix with `update` or `add`, `preview` again. `export` only when the user wants the image file.
10. **Keep the user's drawing.** `add` never moves existing boxes, and `update` touches only what you name. Do not `create` over a file with `overwrite` unless asked.

Worked specs: [references/examples.md](references/examples.md). The example specs there are run by the Writer test suite, so each one builds a valid drawing.
