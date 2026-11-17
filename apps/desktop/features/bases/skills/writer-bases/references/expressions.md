# Bases expression language

Filters and formulas use one grammar. A filter is an expression that must be truthy; a formula is an expression stored by name and shown as a column. `writer base:query` reports a filter or syntax error as exit 1.

## Namespaces

- Bare name or `note.name`: frontmatter property. Use `note["due date"]` when the name has spaces or hyphens.
- `file.*`: `name`, `basename`, `path`, `folder`, `ext`, `size`, `ctime`, `mtime`, `tags`, `links`, `embeds`, `backlinks`, `properties`.
- `formula.name`: another formula of the same base. Formulas may reference each other but not themselves (a cycle is an error value in each formula of the cycle).
- `this`: the file the base is shown for (the base file itself when opened directly).

## Types

string (`"a"` or `'a'`), number, boolean, date (with or without time), duration, list (`[1, 2]`), object, link, file, regexp (`/abc/i`), null. Wikilinks in frontmatter are links. Equality never coerces between types; `==` between a link and a string compares the resolved target or the link text.

## Functions by receiver

- global: `if`, `date`, `now`, `today`, `duration`, `link`, `list`, `number`, `min`, `max`, `file`, `image`, `icon`, `html`, `escapeHTML`, `random`
- any: `isTruthy()`, `isType(t)`, `toString()`
- string: `length`, `contains`, `containsAll`, `containsAny`, `startsWith`, `endsWith`, `isEmpty`, `lower`, `title`, `trim`, `replace(pattern, repl)`, `repeat`, `reverse`, `slice(start, end?)`, `split(sep, n?)`
- number: `abs`, `ceil`, `floor`, `round(digits?)`, `toFixed(n)`, `isEmpty`
- list: `length`, `contains`, `containsAll`, `containsAny`, `filter(expr)`, `map(expr)`, `reduce(expr, acc)`, `flat`, `join(sep)`, `reverse`, `slice`, `sort`, `unique`, `isEmpty`, `sum`, `mean`, `median`, `min`, `max`, `stddev`
- date: `year`, `month`, `day`, `hour`, `minute`, `second`, `millisecond`, `format(fmt)`, `date()`, `time()`, `relative()`, `isEmpty`
- file: `asLink(display?)`, `hasLink(x)`, `hasProperty(name)`, `hasTag(...)`, `inFolder(folder)`
- link: `asFile()`, `linksTo(file)`
- object: `keys`, `values`, `isEmpty`
- regexp: `matches(str)`

When unsure whether a function exists, test it in a throwaway view with `writer base:query`: an unknown function shows as an error cell.

## Dates and durations

- Units: `y`, `M`, `d`, `w`, `h`, `m`, `s` (and long forms). `today() + "7d"`, `now() - "2h"`.
- `date(x) - date(y)` is a duration; read `.days`, `.hours`, `.minutes`, `.seconds`, `.milliseconds`, `.weeks` as fractional totals (`.months` and `.years` are approximate).
- `format` uses Moment-style tokens: `YYYY MM DD HH mm ss`, `MMMM`, `ddd`, `[literal]`, ...
- `date()` accepts `YYYY-MM-DD` with an optional time and offset; anything else is an error.

## Truthiness and errors

`null`, `false`, `0`, `""` and empty lists are falsy. `if` does not swallow errors. A missing property is `null`, not an error; reading a member of `null` is `null`.
