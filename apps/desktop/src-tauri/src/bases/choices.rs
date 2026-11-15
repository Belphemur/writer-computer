//! U-CHOICES: every place where the public Bases docs are silent and the
//! engine had to pick a behaviour.
//!
//! Policy: follow the docs literally; where they say nothing, take the
//! conservative option (no silent coercion, explicit errors for operations that
//! cannot be meaningful, lenient only where a strict choice would turn a
//! routine real-world vault, with mixed-type properties, into an error screen).
//! Each choice is one constant or one function in the module named in the
//! "Where" column, so a black-box probe against real Obsidian (spec section
//! 6.3) can confirm or flip a single line. The same table lives in
//! `SPECs/obsidian-bases-spec.md` ("Implemented semantics and open probes") and
//! `src/bases/README.md`.
//!
//! | Id | Question | Choice | Where |
//! | --- | --- | --- | --- |
//! | U1 | top-level `name:` | preserved in `Document::name`, never interpreted | `document.rs` |
//! | U2 | `Count` summary | number of rows in the group/view, empty cells included | `query.rs` `summarize` |
//! | U3 | duration fields | `.days .hours .minutes .seconds .milliseconds .weeks` are fractional totals (`(now() - d).days` may be 2.5); `.months` = days / 30.4375, `.years` = days / 365.25; sign kept | `interp.rs` `duration_field` |
//! | U4 | errors | unknown function/method, bad types, bad regexp are `Value::Error`; errors propagate through operators and calls; `if` does not swallow them; a filter error makes the whole view an explicit error state ([`FILTER_ERROR_POLICY`]) | `interp.rs`, `query.rs` |
//! | U5 | names | bare identifiers are `[A-Za-z_$][A-Za-z0-9_$]*` plus any non-ASCII alphanumeric (no `-`, so `a-b` is a subtraction); names with spaces or hyphens use `note["a b"]`; property keys match exactly (case-sensitive); a missing property is `null`, not an error | `lexer.rs`, `interp.rs` |
//! | U6 | YAML keys of cards/list/kanban/map options | kept verbatim in `View::extra`, never interpreted | `document.rs` |
//! | U7 | sort | `null` (and error) is lowest: first ascending, last descending; different types order by type rank null < boolean < number < date < duration < string < link < file < list < object; strings compare case-insensitively then by bytes (no locale, no natural number order); stable | `value.rs` `compare_for_sort` |
//! | U8 | groups | sort is applied first (stable), rows keep that order inside a group; groups order by key with the same comparison, reversed for DESC; a list value is one key (not exploded); `groupOrder` entries come first in the listed order, the rest follow in auto order; `limit` applies after grouping; summaries cover the rows that are shown | `query.rs` |
//! | U9 | dates | `date()` accepts `YYYY-MM-DD`, optional `T` or space plus `HH:mm[:ss[.SSS]]`, optional `Z` or `+HH:mm`; anything else is an error; `==` and ordering never coerce strings to dates; bare dates are local midnight; `Value::from_json` can sniff exact ISO strings ([`SNIFF_ISO_DATES`]) | `datetime.rs`, `value.rs` |
//! | U10 | `format()` tokens | Moment subset: `YYYY YY MMMM MMM MM Mo M DDDD DDD Do DD D dddd ddd dd d E Qo Q WW Wo W GGGG HH H hh h kk k mm m ss s SSS SS S A a ZZ Z X x`, `[literal]`, `\` escapes; other characters pass through | `datetime.rs` |
//! | U11 | `file.hasTag` | any-of; case-insensitive; leading `#` ignored; nested (`a` matches `a/b`); which tags exist (code blocks, frontmatter forms) is the row source's job | `functions.rs` |
//! | U12 | coercions | `==` between different types is `false` (no `"1" == 1`); numbers, strings, booleans, null compare by value; `<`, `>`, `<=`, `>=` with a null or mixed types are `false` ([`MIXED_COMPARE_IS_ERROR`]); `+` with a string on either side concatenates display strings, with null or other mixes it is a type error; `x / 0` and `x % 0` are errors; truthiness: null, false, 0, NaN and `""` are falsy, every list/object (even empty) is truthy ([`EMPTY_LIST_IS_TRUTHY`]); member access on null is null and a method on null is null except the any-type methods ([`NULL_PROPAGATES`]) | `value.rs`, `interp.rs` |
//! | U13 | list statistics | `sum mean median min max stddev` exist on lists (population stddev, numbers only, non-numbers skipped) so docs examples such as `values.mean().round(3)` work | `functions.rs` |
//! | U14 | `file.hasLink(x)` | `x` a file: compare resolved paths of `file.links`; `x` a string: resolve it like link text, compare resolved paths, else compare lowercased link text; frontmatter links count (the row source supplies them) | `functions.rs` |
//! | U15 | `this` | a file value; `this.file` is itself, `this.note` its properties, other names are file fields first, then note properties; the row source decides what it is (base file, embedding note, active file) | `interp.rs` |
//! | U16 | embed limits/heights | not an engine concern | (UI) |
//! | U17 | which files are rows | decided by the `RowSource` (index) | `query.rs` |
//! | U18 | link resolution | decided by `RowContext::resolve_link`; link equality: both resolved => same path, else same lowercased text | `value.rs` |
//! | U19 | property types vs `types.json` | the row source delivers typed values; the engine never re-types except wikilink strings, which become links | `interp.rs` |
//! | U20 | missing/cyclic formulas | `formula.x` for an undefined formula is an error value; a cycle is an error value on every formula in the cycle; a formula with a syntax error is an error value in its own column only | `interp.rs` |
//!
//! Other documented-silent details: `flat()` flattens one level; `split(sep, n)`
//! keeps at most `n` pieces (JS style); `replace` with a string pattern replaces
//! every occurrence, with a regexp only the `g` flag makes it global; `round`
//! rounds half away from zero; the default column title is the property id
//! without a `note.` prefix; `Range` of dates is a duration; `Unique` counts
//! distinct non-empty values; `Sum` of no numbers is 0 and the other number
//! summaries of no numbers are null; `Stddev` is the population deviation.

/// Policy for a filter that evaluates to an error on some row.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FilterErrorPolicy {
    /// The whole view becomes an explicit error state with zero rows (spec 7.5).
    ErrorState,
    /// The row is treated as not matching (lenient; for probes).
    RowFails,
}

/// U4.
pub const FILTER_ERROR_POLICY: FilterErrorPolicy = FilterErrorPolicy::ErrorState;
/// U12: ordering operators on mixed types: `false` => result is `false`.
pub const MIXED_COMPARE_IS_ERROR: bool = false;
/// U12.
pub const EMPTY_LIST_IS_TRUTHY: bool = true;
/// U12.
pub const EMPTY_OBJECT_IS_TRUTHY: bool = true;
/// U12: `null.length` is null and `null.lower()` is null.
pub const NULL_PROPAGATES: bool = true;
/// U9: `Value::from_json` turns exact `YYYY-MM-DD[THH:mm...]` strings into dates.
pub const SNIFF_ISO_DATES: bool = true;
