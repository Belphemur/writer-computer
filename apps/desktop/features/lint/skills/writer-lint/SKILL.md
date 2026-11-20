---
name: writer-lint
description: Fix and check the Markdown formatting of a note with Writer's linter. Use after you edit or create a Markdown note in this vault, and when asked to tidy, lint or clean up a note's formatting.
---

# Markdown lint

Writer lints Markdown with a built-in linter. It leaves Obsidian syntax alone (wiki links, embeds, callouts, block ids, `%%` comments, front matter) and runs the rules the user switched on in Writer's settings.

## After you edit a note

Run, with the note's vault path or its name:

```sh
writer lint:fix path=Notes/Idea.md
```

It rewrites the note in place and prints the rules it applied. Only formatting-only rules run by default (`scope=safe`). Do not use `scope=all` unless the user asks: it also runs rules that can change what the note says.

## What is left

```sh
writer lint path=Notes/Idea.md
```

lists the findings the fix did not clear, one per line: `path:line:column RULE message`, with `[fixable]` when a fix exists. Add `format=json` to read them as data. Fix what is left by hand when it is yours to change; mention a finding you leave.

## Rules

`rules=MD009,MD012` runs only those rules (ids are the markdownlint ones, such as MD009 trailing spaces, MD012 multiple blank lines, MD022 blank lines around headings, MD047 final newline). Without it the user's own selection applies, so do not assume a rule is on.

Never edit a note's formatting by hand to satisfy a rule the linter can fix: run `lint:fix`.
