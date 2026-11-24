//! What must hold of a running server before the first prompt of each of its starts: the checks
//! of the one "config in force" gate (`transport.rs`), pure over the server's own answers.
//!
//! With the user's own OpenCode config loaded, Writer's file is no longer the only input, so the
//! file is not proof. These read the facts back:
//!
//! - [`mcp_violations`]: `GET /api/mcp` lists only Writer's server and the ones switched on;
//!   any other that is running (`connected` or `pending`: a server that is not running offers no tools) is a violation (this also catches a built-in server such as
//!   `opencode_console`, and any future one);
//! - [`permissions_in_force`]: the resolved permissions of every agent of Writer's end as Writer
//!   wrote them (capture C5: rules are concatenated and the last match wins, so Writer's list is
//!   a contiguous run and what follows it can only be OpenCode's own denies).
//!
//! The foreign agents are [`super::config::foreign_agents`]. Names, actions and effects only.

use super::opencode_api as api;
use crate::agent::mcp_wiring::server_key;
use crate::cli::mcp::SERVER_NAME;
use serde_json::Value;
use std::collections::BTreeSet;

/// What the server's configuration must be, from the document Writer wrote.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Expectation {
    /// The MCP server names that may be anything but `disabled`: Writer's own and the ones on.
    pub mcp_allowed: Vec<String>,
    /// Each agent of Writer's that is on, with the permissions list Writer wrote for it.
    pub agents: Vec<(String, Vec<Value>)>,
}

impl Expectation {
    /// Reads it from the rendered document (overrides included).
    pub fn of(doc: &Value) -> Self {
        let mut mcp_allowed = vec![SERVER_NAME.to_string()];
        mcp_allowed.extend(
            doc["policies"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|p| p["action"] == "mcp.use" && p["effect"] == "allow")
                .filter_map(|p| p["resource"].as_str().map(String::from)),
        );
        let agents = doc["agents"]
            .as_object()
            .into_iter()
            .flatten()
            .filter(|(_, d)| d["disabled"] != true)
            .filter_map(|(id, d)| Some((id.clone(), d["permissions"].as_array()?.clone())))
            .collect();
        Self {
            mcp_allowed,
            agents,
        }
    }
}

/// The servers `GET /api/mcp` lists that are running and that Writer did not allow
/// (compared by [`server_key`], the name a harness knows a server by).
pub fn mcp_violations(list: &Value, allowed: &[String]) -> Vec<String> {
    let allowed: BTreeSet<String> = allowed.iter().map(|n| server_key(n)).collect();
    api::mcp_statuses(list.clone())
        .into_iter()
        .filter(|s| s.status.is_running() && !allowed.contains(&server_key(&s.name)))
        .map(|s| s.name)
        .collect()
}

fn triple(rule: &Value) -> (&str, &str, &str) {
    (
        rule["action"].as_str().unwrap_or(""),
        rule["resource"].as_str().unwrap_or(""),
        rule["effect"].as_str().unwrap_or(""),
    )
}

/// Whether `resolved` (the list of an agent from `GET /api/agent`) holds `wrote` as one run and
/// nothing after it loosens it: what follows can only be a deny (OpenCode's own tail, `browser`).
pub fn run_is_in_force(resolved: &[Value], wrote: &[Value]) -> bool {
    if wrote.is_empty() {
        return true;
    }
    let (r, w): (Vec<_>, Vec<_>) = (
        resolved.iter().map(triple).collect(),
        wrote.iter().map(triple).collect(),
    );
    if r.len() < w.len() {
        return false;
    }
    // the last run: a rule of the user's that equals Writer's list earlier does not count
    (0..=r.len() - w.len())
        .rev()
        .find(|i| r[*i..*i + w.len()] == w[..])
        .is_some_and(|i| {
            r[i + w.len()..]
                .iter()
                .all(|(_, _, effect)| *effect == "deny")
        })
}

/// The first agent of Writer's, among the ones the server lists, whose resolved permissions are not
/// what Writer wrote. An agent the server does not list cannot run, so it is not a hazard. `None`:
/// all hold.
pub fn permissions_in_force(agents: &[Value], expect: &Expectation) -> Option<String> {
    expect.agents.iter().find_map(|(id, wrote)| {
        let listed = agents.iter().find(|a| a["id"] == id.as_str())?;
        let held = run_is_in_force(
            listed["permissions"].as_array().map_or(&[], Vec::as_slice),
            wrote,
        );
        (!held).then(|| id.clone())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn r(action: &str, effect: &str) -> Value {
        json!({"action": action, "resource": "*", "effect": effect})
    }

    #[test]
    fn mcp_lists_only_what_is_allowed_or_disabled() {
        let list = json!({"data": [
            {"name": "writer", "status": {"status": "connected"}},
            {"name": "my.srv", "status": {"status": "pending"}},
            {"name": "g-a", "status": {"status": "disabled"}},
            {"name": "g-x", "status": {"status": "connected"}},
            {"name": "g-b", "status": {"status": "failed", "error": "x"}},
            {"name": "opencode_console", "status": {"status": "needs_auth"}},
        ]});
        let allowed = vec!["writer".to_string(), "my_srv".to_string()];
        assert_eq!(
            mcp_violations(&list, &allowed),
            ["g-x"],
            "names compare as keys; a server that is not running (disabled, failed, needs auth) is fine"
        );
        assert!(mcp_violations(&json!({"data": []}), &allowed).is_empty());
    }

    #[test]
    fn writers_list_must_be_a_run_followed_only_by_denies() {
        let wrote = vec![r("*", "ask"), r("read", "allow")];
        let tail = [r("browser", "deny")];
        let ok = [
            vec![r("*", "allow")],
            vec![r("*", "ask")],
            wrote.clone(),
            tail.to_vec(),
        ]
        .concat();
        assert!(run_is_in_force(&ok, &wrote));
        // a later allow of something else (a global agent merged after) loosens it
        let loosened = [wrote.clone(), vec![r("edit", "allow")]].concat();
        assert!(!run_is_in_force(&loosened, &wrote));
        // not there at all, or broken in the middle
        assert!(!run_is_in_force(&[r("*", "ask")], &wrote));
        assert!(!run_is_in_force(
            &[r("*", "ask"), r("edit", "allow"), r("read", "allow")],
            &wrote
        ));
        assert!(
            run_is_in_force(&[], &[]),
            "nothing written, nothing to hold"
        );
    }

    #[test]
    fn the_first_listed_agent_that_is_not_in_force_is_named_and_an_unlisted_one_cannot_run() {
        let doc = json!({"agents": {
            "build": {"disabled": true},
            "writer": {"permissions": [r("*", "ask"), r("read", "allow")]},
            "writer-explorer": {"permissions": [r("*", "deny")]},
        }});
        let expect = Expectation::of(&doc);
        assert_eq!(expect.agents.len(), 2, "a disabled agent is not expected");
        let listed = json!([
            {"id": "writer", "permissions": [r("*", "ask"), r("read", "allow"), r("browser", "deny")]},
            {"id": "writer-explorer", "permissions": [r("*", "deny")]},
        ]);
        let agents = listed.as_array().unwrap();
        assert_eq!(permissions_in_force(agents, &expect), None);
        assert_eq!(
            permissions_in_force(&agents[..1], &expect),
            None,
            "an agent the server does not list cannot run"
        );
        let loosened = json!([
            {"id": "writer", "permissions": [r("*", "ask"), r("read", "allow")]},
            {"id": "writer-explorer", "permissions": [r("*", "allow")]},
        ]);
        assert_eq!(
            permissions_in_force(loosened.as_array().unwrap(), &expect).as_deref(),
            Some("writer-explorer")
        );
    }

    #[test]
    fn the_expectation_allows_writers_server_and_the_servers_the_policies_allow() {
        let doc = json!({"policies": [
            {"action": "mcp.use", "resource": "*", "effect": "deny"},
            {"action": "mcp.use", "resource": "writer", "effect": "allow"},
            {"action": "mcp.use", "resource": "g-a", "effect": "allow"},
            {"action": "provider.use", "resource": "x", "effect": "deny"},
        ]});
        assert_eq!(
            Expectation::of(&doc).mcp_allowed,
            ["writer", "writer", "g-a"]
        );
    }
}
