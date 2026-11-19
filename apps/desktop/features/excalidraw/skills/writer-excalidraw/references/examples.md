# Worked examples

Every `spec` block below is a complete spec for `excalidraw:create`; a `spec add` or `spec update` block is for `excalidraw:add` or `excalidraw:update` on the drawing the block before it made.

## Architecture, left to right

Three layers; the focus is the API (blue), the rest is context (gray). The group keeps the data layer together.

```spec
{
  "direction": "LR",
  "nodes": [
    { "id": "client", "text": "Web app", "color": "gray" },
    { "id": "api", "text": "API", "color": "blue" },
    { "id": "queue", "text": "Job queue", "color": "gray" },
    { "id": "worker", "text": "Worker", "color": "gray" },
    { "id": "db", "text": "Database", "shape": "ellipse", "color": "gray" },
    { "id": "cache", "text": "Cache", "shape": "ellipse", "color": "gray" }
  ],
  "edges": [
    ["client", "api", "requests"],
    ["api", "db", "reads"],
    ["api", "cache"],
    ["api", "queue", "enqueues"],
    ["queue", "worker"],
    ["worker", "db", "writes"]
  ],
  "groups": [{ "nodes": ["db", "cache"] }]
}
```

## Decision flow, top to bottom

Diamonds are decisions; the labels on the arrows out of a diamond are the answers.

```spec
{
  "direction": "TB",
  "nodes": [
    { "id": "start", "text": "Request arrives", "shape": "ellipse" },
    { "id": "auth", "text": "Signed in?", "shape": "diamond", "color": "yellow" },
    { "id": "login", "text": "Show login" },
    { "id": "limit", "text": "Under the limit?", "shape": "diamond", "color": "yellow" },
    { "id": "serve", "text": "Serve the page", "color": "green" },
    { "id": "reject", "text": "Reject with 429", "color": "red" }
  ],
  "edges": [
    ["start", "auth"],
    ["auth", "login", "no"],
    ["auth", "limit", "yes"],
    ["limit", "serve", "yes"],
    ["limit", "reject", "no"]
  ]
}
```

## Lanes: who does what

One group per actor; the arrows cross between lanes. Positions are given so the lanes stay in rows.

```spec
{
  "direction": "LR",
  "nodes": [
    { "id": "u1", "text": "Write draft", "x": 0, "y": 0, "color": "blue" },
    { "id": "u2", "text": "Revise", "x": 400, "y": 0, "color": "blue" },
    { "id": "r1", "text": "Review", "x": 200, "y": 160, "color": "purple" },
    { "id": "r2", "text": "Approve", "x": 600, "y": 160, "color": "purple" }
  ],
  "edges": [["u1", "r1"], ["r1", "u2", "comments"], ["u2", "r2"]],
  "groups": [{ "nodes": ["u1", "u2"] }, { "nodes": ["r1", "r2"] }]
}
```

## Mind map

One centre, branches around it. A mind map has no flow, so give positions.

```spec
{
  "nodes": [
    { "id": "centre", "text": "Launch plan", "shape": "ellipse", "color": "blue", "x": 0, "y": 0 },
    { "id": "a", "text": "Audience", "x": -320, "y": -140 },
    { "id": "b", "text": "Message", "x": 320, "y": -140 },
    { "id": "c", "text": "Channels", "x": -320, "y": 160 },
    { "id": "d", "text": "Timeline", "x": 320, "y": 160 }
  ],
  "edges": [["centre", "a"], ["centre", "b"], ["centre", "c"], ["centre", "d"]]
}
```

## Comparison

Two options side by side, one group each, a title above each.

```spec
{
  "direction": "TB",
  "nodes": [
    { "id": "ta", "text": "Option A", "shape": "text", "x": 0, "y": 0 },
    { "id": "a1", "text": "Fast to build", "color": "green", "x": 0, "y": 60 },
    { "id": "a2", "text": "Hard to change", "color": "red", "x": 0, "y": 160 },
    { "id": "tb", "text": "Option B", "shape": "text", "x": 300, "y": 0 },
    { "id": "b1", "text": "Slower to build", "color": "red", "x": 300, "y": 60 },
    { "id": "b2", "text": "Easy to change", "color": "green", "x": 300, "y": 160 }
  ],
  "groups": [{ "nodes": ["ta", "a1", "a2"] }, { "nodes": ["tb", "b1", "b2"] }]
}
```

## Build in steps

Step 1, `create` the skeleton:

```spec
{
  "nodes": [
    { "id": "idea", "text": "Idea", "shape": "ellipse" },
    { "id": "build", "text": "Build" },
    { "id": "ship", "text": "Ship", "color": "green" }
  ],
  "edges": [["idea", "build"], ["build", "ship"]]
}
```

Step 2, `add` a branch below it that points at boxes already there (`build`) by their ids:

```spec add
{
  "nodes": [
    { "id": "test", "text": "Test", "color": "yellow" },
    { "id": "fix", "text": "Fix bugs" }
  ],
  "edges": [["build", "test"], ["test", "fix", "fails"], ["fix", "test"], ["test", "ship", "passes"]]
}
```

Step 3, an `add` with only `edges` draws one more arrow between boxes already there:

```spec add
{ "edges": [["idea", "ship", "skip"]] }
```

Step 4, after a `preview` showed "Fix bugs" is the wrong word and `test` should stand out, `update` changes them and drops the skip arrow:

```spec update
{
  "nodes": [
    { "id": "fix", "text": "Fix and retest", "color": "orange" },
    { "id": "test", "color": "red" }
  ],
  "edges": [["test", "fix", "fails twice"]],
  "remove": { "edges": [["idea", "ship"]] }
}
```

Then `excalidraw:read` to check, `excalidraw:preview` to look, `excalidraw:export` for the image.
