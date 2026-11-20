//! The rule registry: the one list of the rules Writer exposes, shared with the settings page and
//! the agent skill (`features/lint/rules.json`, ADR 2026-11-19). A rule rumdl adds in an upgrade
//! is off and unlisted until it is added there.

use serde::Deserialize;
use std::collections::BTreeSet;
use std::sync::OnceLock;

#[derive(Debug, Clone, Deserialize)]
pub struct Rule {
    /// The markdownlint id rumdl names the rule by (`MD009`).
    pub id: String,
    /// The short label of Settings.
    pub name: String,
    /// Its fix changes formatting only, never meaning: the only rules fix-on-save runs.
    pub safe: bool,
    /// On until the user turns it off.
    pub default: bool,
    /// The rule can offer a fix.
    pub fixable: bool,
}

#[derive(Deserialize)]
struct File {
    rules: Vec<Rule>,
}

static REGISTRY: OnceLock<Vec<Rule>> = OnceLock::new();

/// Every exposed rule, in id order.
pub fn all() -> &'static [Rule] {
    REGISTRY.get_or_init(|| {
        let file: File = serde_json::from_str(include_str!("../../../features/lint/rules.json"))
            .expect("features/lint/rules.json is valid");
        file.rules
    })
}

pub fn get(id: &str) -> Option<&'static Rule> {
    all().iter().find(|r| r.id == id)
}

/// The ids on for a user who changed nothing.
pub fn defaults() -> BTreeSet<String> {
    all()
        .iter()
        .filter(|r| r.default)
        .map(|r| r.id.clone())
        .collect()
}
