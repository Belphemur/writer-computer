//! The "Always allow" choice of a permission card, turned into what the backend persists. The
//! suggestions of a request keep one shape for every backend (`addRules` / `setMode`, the shape the
//! web reads): a backend's mapper builds them from its own protocol (spec
//! `SPECs/opencode-backend-spec.md` section 1, "Always allow"), the card's choice selects among
//! them, and this one function rebuilds what to persist, from the request's own suggestions, never
//! from UI input. Tauri-free, pure.

use super::events::PermissionPersist;
use serde_json::{json, Value};

/// What the backend is told to persist for an "Always allow" choice, rebuilt from the suggestions
/// of the request (the backend's, or Writer's proposal, `bash_rules`), never from UI input: `rules`, the
/// `ruleContent`s the user kept ticked, only selects among the rules those suggestions already
/// carry (`None` keeps all). `project` writes `<cwd>/.claude/settings.local.json` (verified).
pub fn updated_permissions(
    suggestions: &[Value],
    persist: Option<PermissionPersist>,
    rules: Option<&[String]>,
) -> Vec<Value> {
    let Some(persist) = persist else {
        return Vec::new();
    };
    suggestions
        .iter()
        .filter_map(|s| {
            let kind = s.get("type").and_then(Value::as_str)?;
            match (persist, kind) {
                (PermissionPersist::Project, "addRules") => {
                    chosen_rules(s, rules).and_then(|s| with_destination(&s, "localSettings"))
                }
                (PermissionPersist::Session, "addRules") => {
                    chosen_rules(s, rules).and_then(|s| with_destination(&s, "session"))
                }
                (PermissionPersist::AcceptEdits, "setMode")
                    if s.get("mode").and_then(Value::as_str) == Some("acceptEdits") =>
                {
                    with_destination(s, "session")
                }
                _ => None,
            }
        })
        .collect()
}

/// The suggestion narrowed to the ticked rules (`None` when none of them is in it), without
/// Writer's own `proposal` marker, which the CLI does not know.
fn chosen_rules(s: &Value, rules: Option<&[String]>) -> Option<Value> {
    let mut v = s.clone();
    let obj = v.as_object_mut()?;
    obj.remove("proposal");
    if let Some(keep) = rules {
        let kept: Vec<Value> = obj
            .get("rules")
            .and_then(Value::as_array)?
            .iter()
            .filter(|r| {
                r.get("ruleContent")
                    .and_then(Value::as_str)
                    .is_some_and(|c| keep.iter().any(|k| k == c))
            })
            .cloned()
            .collect();
        if kept.is_empty() {
            return None;
        }
        obj.insert("rules".into(), Value::Array(kept));
    }
    Some(v)
}

fn with_destination(s: &Value, dest: &str) -> Option<Value> {
    let mut v = s.clone();
    v.as_object_mut()?.insert("destination".into(), json!(dest));
    Some(v)
}
