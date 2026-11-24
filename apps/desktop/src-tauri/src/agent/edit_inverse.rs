//! The capture timing gap: the pre-image is read when a tool call's input is complete, which is
//! about when the CLI runs the tool, so the read can lose the race and already hold the edit.
//! Pure functions over the call's input and the captured text; `changes.rs` calls [`settle`]
//! right after the read. Tauri-free. Spec: `SPECs/native-agent-spec.md` "Turn changes".
//!
//! The tools and the input keys come from the backend's tool table (`tool_table.rs`), by role:
//! `replace` and `multi-replace` (Claude: `Edit`, `MultiEdit`), `create` (`Write`).
//!
//! - A replace / multi-replace: the captured text `T` is judged against the edits (`old_string` ->
//!   `new_string`, `replace_all`, in order). The tool "could still run on `T`" when applying the
//!   edits forward succeeds (every `old_string` found, unique unless `replace_all`). The tool "may
//!   have run" when undoing them from the end (every `new_string` swapped back to its
//!   `old_string`, unique unless `replace_all`) gives a text that the forward edits turn into
//!   exactly `T` again. Could-still-run only: `T` is the pre-image. May-have-run only: the undone
//!   text is the pre-image. Both: ambiguous. Neither: the edit failed or changed nothing, unless
//!   it deletes text or all its new strings are in `T` (then a run cannot be ruled out). Every
//!   ambiguous case is [`Settled::Unknown`]; nothing is guessed.
//! - A create: a captured text equal to the written content means the write may already have
//!   happened (or rewrote the same content): [`Settled::Unknown`], never dropped.
//! - Anything else: the capture stands.

use super::tool_table::{Role, ToolTable};
use serde_json::Value;

#[derive(Debug, PartialEq, Eq)]
pub enum Settled {
    /// The captured text is the pre-image.
    AsCaptured,
    /// The tool had already run; this is the text from before it.
    Reconstructed(String),
    /// The tool had or may have run and the text from before cannot be established.
    Unknown,
}

struct Step {
    old: String,
    new: String,
    all: bool,
}

/// The edits of a replace or multi-replace call; `None` for another tool or an input of another
/// shape.
fn steps(tools: &ToolTable, tool: &str, input: &Value) -> Option<Vec<Step>> {
    let args = tools.args(tool)?;
    let (old, new) = (args.old.as_deref()?, args.new.as_deref()?);
    let one = |v: &Value| -> Option<Step> {
        Some(Step {
            old: v.get(old)?.as_str()?.to_string(),
            new: v.get(new)?.as_str()?.to_string(),
            all: args
                .all
                .as_deref()
                .and_then(|k| v.get(k))
                .and_then(Value::as_bool)
                .unwrap_or(false),
        })
    };
    match tools.role(tool)? {
        Role::Replace => Some(vec![one(input)?]),
        Role::MultiReplace => input
            .get(args.edits.as_deref()?)?
            .as_array()?
            .iter()
            .map(one)
            .collect::<Option<Vec<_>>>()
            .filter(|s| !s.is_empty()),
        _ => None,
    }
}

/// Replaces `from` by `to` the way the edit tools do: it must occur, and once unless `all`.
fn swap(text: &str, from: &str, to: &str, all: bool) -> Option<String> {
    if from.is_empty() || from == to {
        return None;
    }
    match text.matches(from).count() {
        0 => None,
        1 => Some(text.replacen(from, to, 1)),
        _ if all => Some(text.replace(from, to)),
        _ => None,
    }
}

fn forward(text: &str, steps: &[Step]) -> Option<String> {
    steps
        .iter()
        .try_fold(text.to_string(), |t, s| swap(&t, &s.old, &s.new, s.all))
}

fn inverse(text: &str, steps: &[Step]) -> Option<String> {
    steps
        .iter()
        .rev()
        .try_fold(text.to_string(), |t, s| swap(&t, &s.new, &s.old, s.all))
}

pub fn settle(tools: &ToolTable, tool: &str, input: &Value, captured: &str) -> Settled {
    if tools.role(tool) == Some(Role::Create) {
        let content = tools
            .args(tool)
            .and_then(|a| a.content.as_deref())
            .and_then(|k| input.get(k))
            .and_then(Value::as_str);
        return match content {
            Some(content) if content == captured => Settled::Unknown,
            _ => Settled::AsCaptured,
        };
    }
    let Some(steps) = steps(tools, tool, input) else {
        return Settled::AsCaptured;
    };
    let can_run = forward(captured, &steps).is_some();
    let undone = inverse(captured, &steps)
        .filter(|before| forward(before, &steps).as_deref() == Some(captured));
    match (can_run, undone) {
        (true, None) => Settled::AsCaptured,
        (false, Some(before)) => Settled::Reconstructed(before),
        (true, Some(_)) => Settled::Unknown,
        (false, None) => {
            let deletes = steps.iter().any(|s| s.new.is_empty());
            let all_present = steps.iter().all(|s| captured.contains(&s.new));
            if deletes || all_present {
                Settled::Unknown
            } else {
                Settled::AsCaptured
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Claude's table: the tests below are about its tools.
    fn settle(tool: &str, input: &Value, captured: &str) -> Settled {
        super::settle(
            crate::agent::backend::claude().tools(),
            tool,
            input,
            captured,
        )
    }

    fn edit(old: &str, new: &str, all: bool) -> Value {
        json!({"file_path": "a.md", "old_string": old, "new_string": new, "replace_all": all})
    }

    #[test]
    fn a_file_the_tool_has_not_touched_is_the_pre_image() {
        let input = edit("two", "TWO", false);
        assert_eq!(settle("Edit", &input, "one two three"), Settled::AsCaptured);
        // a failed edit (nothing to replace, nothing replaced) changes nothing
        assert_eq!(settle("Edit", &input, "one three"), Settled::AsCaptured);
    }

    #[test]
    fn an_edit_that_already_ran_is_undone_exactly() {
        let input = edit("two", "TWO", false);
        assert_eq!(
            settle("Edit", &input, "one TWO three"),
            Settled::Reconstructed("one two three".into())
        );
    }

    #[test]
    fn replace_all_is_undone_for_every_occurrence() {
        let input = edit("cat", "dog", true);
        assert_eq!(
            settle("Edit", &input, "dog and dog"),
            Settled::Reconstructed("cat and cat".into())
        );
        // not yet run: the pre-image already holds the old strings
        assert_eq!(settle("Edit", &input, "cat and cat"), Settled::AsCaptured);
    }

    #[test]
    fn multi_edit_is_undone_in_reverse_order() {
        // "a" -> "b" then "b!" -> "c": the second edit depends on the first
        let input = json!({"file_path": "a.md", "edits": [
            {"old_string": "a", "new_string": "b"},
            {"old_string": "b!", "new_string": "c"},
        ]});
        assert_eq!(settle("MultiEdit", &input, "x a! y"), Settled::AsCaptured);
        assert_eq!(
            settle("MultiEdit", &input, "x c y"),
            Settled::Reconstructed("x a! y".into())
        );
    }

    #[test]
    fn a_new_string_that_also_sits_elsewhere_is_not_a_run() {
        // the pre-image already holds "b" elsewhere; "a" is still there: it can still run
        let input = edit("p", "q", false);
        assert_eq!(settle("Edit", &input, "p and q"), Settled::AsCaptured);
    }

    #[test]
    fn ambiguity_is_never_guessed() {
        // "foo" -> "foo bar": after the run both strings are present, before it only "foo"
        let grow = edit("foo", "foo bar", false);
        assert_eq!(settle("Edit", &grow, "foo"), Settled::AsCaptured);
        assert_eq!(settle("Edit", &grow, "foo bar"), Settled::Unknown);
        // the new string occurs twice after the run: which one was the edit?
        let input = edit("x", "b", false);
        assert_eq!(settle("Edit", &input, "b and b"), Settled::Unknown);
        // a deletion leaves nothing to find
        let del = edit("gone", "", false);
        assert_eq!(settle("Edit", &del, "kept"), Settled::Unknown);
        assert_eq!(settle("Edit", &del, "kept gone"), Settled::AsCaptured);
    }

    #[test]
    fn write_equal_to_the_capture_may_have_run() {
        let input = json!({"file_path": "a.md", "content": "hello\n"});
        assert_eq!(settle("Write", &input, "hello\n"), Settled::Unknown);
        assert_eq!(settle("Write", &input, "older\n"), Settled::AsCaptured);
    }

    #[test]
    fn other_tools_and_odd_inputs_stand() {
        assert_eq!(settle("NotebookEdit", &json!({}), "x"), Settled::AsCaptured);
        assert_eq!(
            settle("Edit", &json!({"file_path": "a"}), "x"),
            Settled::AsCaptured
        );
        assert_eq!(
            settle("MultiEdit", &json!({"edits": []}), "x"),
            Settled::AsCaptured
        );
    }
}
