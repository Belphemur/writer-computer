---
name: writer-diagram
description: Draw or update a diagram of how systems connect (an architecture, a topology, a data flow) from what the vault says. Use when the user asks to draw or diagram how things connect, to update an existing drawing, or when a note needs a topology picture. Not for charts of data. Researches the vault first, models zones, boxes and edges, builds the drawing with the `excalidraw:` commands, lints and previews until it reads well, and links it from its notes.
---

# Diagram how systems connect

The commands and the spec fields are in the `writer-excalidraw` skill; this is the workflow around them. Search with `writer search`, `graph:*` and the `writer-cli` skill.

## Where it goes

Next to the notes it explains, or in a `Diagrams/` folder near them. A spec file is optional: `excalidraw:read` prints exactly what `create` takes, so the drawing is its own source.

## 1. Research before drawing

Search the vault first: `writer search`, `graph:neighbors` and `graph:backlinks` on the notes involved, Bases, and the notes the user names. Send wider searches to sub-agents and keep their findings short.

Keep an arrow only if a source states it. Anything you are unsure of goes in the `legend` under "Open", never as an arrow.

## 2. Model

- **Zones** are where things run, not who owns them.
- **Boxes** are components.
- **Edges** are mechanisms (what carries the call, the event, the file).
- The **legend** holds colours, scope, open items and sources.

## 3. Layout rules

- Colour by zone type: named colours, or a `fill` with readable text.
- One arrow per pair; `bidirectional` for a two-way link.
- No three talking nodes in a row (the middle one hides the line between its neighbours).
- Short labels: the mechanism only. Collide? Use `labelAt`, or choose `fromSide` and `toSide`.
- Leave space between zones.
- Dashed edges for planned links.
- `link: "[[Note]]"` on every box that has a note.

## 4. Build, lint, preview, iterate

1. Write the spec to a file and `excalidraw:create path=... spec=@file` (add `check` first for a long spec).
2. `excalidraw:lint` until `clean` is true.
3. `excalidraw:preview`, open the image, look.
4. Fix and repeat. Two or three passes is normal.

## 5. Link it

Embed `![[Title.excalidraw]]` in the main note, and add it to the related links if the vault uses them.

## Updating a drawing

`excalidraw:read` first so hand edits survive. Small change: `excalidraw:update`. Structural change: edit the `read` output and `create` over the file with `overwrite`.

## Rules

- Every arrow traces to a source.
- Use the exact names of the vault's notes.
- Show the exported image to the user before anything goes outside the vault.
- End the reply with the drawing and the notes you touched, as wikilinks.
