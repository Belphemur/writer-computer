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

/// One allow rule of a permission ruleset, as a backend that keeps rules by action and resource
/// reads it (`{action, resource, effect}`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AllowRule {
    pub action: String,
    pub resource: String,
}

/// One rule of a ruleset in the shape a backend that keeps rules by action and resource reads:
/// `{action, resource, effect}`. The one place that writes the shape.
pub fn rule_json(action: &str, resource: &str, effect: &str) -> Value {
    json!({"action": action, "resource": resource, "effect": effect})
}

impl AllowRule {
    pub fn to_json(&self) -> Value {
        rule_json(&self.action, &self.resource, "allow")
    }
}

/// The rules of [`updated_permissions`]' `addRules` entries as `(action, resource)` pairs: a
/// suggestion's `toolName` is the backend's action and its `ruleContent` the pattern. The one
/// reading of a chosen suggestion for a backend that keeps rules itself (OpenCode); a `setMode`
/// entry carries no rule. Pure, from the request's own suggestions, never from UI input.
pub fn allow_rules(updated: &[Value]) -> Vec<AllowRule> {
    updated
        .iter()
        .filter(|u| {
            u.get("type").and_then(Value::as_str) == Some("addRules")
                && u.get("behavior").and_then(Value::as_str) == Some("allow")
        })
        .flat_map(|u| {
            u.get("rules")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        })
        .filter_map(|r| {
            Some(AllowRule {
                action: r.get("toolName")?.as_str()?.to_string(),
                resource: r.get("ruleContent")?.as_str()?.to_string(),
            })
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

#[cfg(test)]
mod tests {
    use super::*;

    fn suggestions() -> Vec<Value> {
        vec![
            json!({"type": "addRules", "behavior": "allow", "destination": "localSettings",
                "rules": [{"toolName": "shell", "ruleContent": "echo *"},
                          {"toolName": "shell", "ruleContent": "ls *"}]}),
            json!({"type": "setMode", "mode": "acceptEdits", "destination": "session"}),
        ]
    }

    /// The rules a backend that keeps them itself reads are those of the chosen suggestion, as
    /// `{action, resource, effect}`, narrowed to the ticked ones, and nothing else.
    #[test]
    fn a_chosen_suggestion_becomes_allow_rules_by_action_and_resource() {
        let s = suggestions();
        let all = allow_rules(&updated_permissions(
            &s,
            Some(PermissionPersist::Session),
            None,
        ));
        assert_eq!(
            all.iter().map(AllowRule::to_json).collect::<Vec<_>>(),
            [
                json!({"action": "shell", "resource": "echo *", "effect": "allow"}),
                json!({"action": "shell", "resource": "ls *", "effect": "allow"}),
            ]
        );
        let ticked = ["ls *".to_string(), "rm -rf *".to_string()];
        let one = allow_rules(&updated_permissions(
            &s,
            Some(PermissionPersist::Session),
            Some(&ticked),
        ));
        assert_eq!(one.len(), 1);
        assert_eq!(one[0].resource, "ls *");
        // a mode switch carries no rule, no choice carries none either
        assert!(allow_rules(&updated_permissions(
            &s,
            Some(PermissionPersist::AcceptEdits),
            None
        ))
        .is_empty());
        assert!(allow_rules(&updated_permissions(&s, None, None)).is_empty());
        // a deny is never read as an allow
        let deny = [json!({"type": "addRules", "behavior": "deny",
            "rules": [{"toolName": "shell", "ruleContent": "*"}]})];
        assert!(allow_rules(&deny).is_empty());
    }
}
