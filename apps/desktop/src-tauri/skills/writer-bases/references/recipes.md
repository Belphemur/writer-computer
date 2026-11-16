# Bases recipes

Each snippet is a complete `.base` file. Adjust folders and property names, then verify with `writer base:views` and `writer base:query`.

## Open tasks by due date

```yaml
filters:
  and:
    - file.inFolder("Tasks")
    - 'status != "done"'
formulas:
  days_left: 'if(due, (date(due) - today()).days, "")'
properties:
  formula.days_left:
    displayName: Days left
views:
  - type: table
    name: Open
    order: [file.name, status, due, formula.days_left]
    sort:
      - { property: due, direction: ASC }
```

## Notes with a tag, grouped by status

```yaml
filters:
  and:
    - file.hasTag("project")
    - file.ext == "md"
views:
  - type: table
    name: Projects
    order: [file.name, status, file.mtime]
    groupBy: { property: status, direction: ASC }
    summaries:
      file.name: Count
```

## Recently modified, last 7 days

```yaml
filters:
  and:
    - file.ext == "md"
    - "(now() - file.mtime).days <= 7"
views:
  - type: table
    name: Recent
    order: [file.name, file.folder, file.mtime]
    sort:
      - { property: file.mtime, direction: DESC }
    limit: 25
```

## Notes linking to this note's topic

```yaml
filters:
  and:
    - file.hasLink("Topic")
views:
  - type: table
    name: Mentions
    order: [file.name, file.folder]
```

Running a view from the CLI: `writer base:query file=<base name> view=<view name> format=paths` lists the files, `format=md` prints a table.
