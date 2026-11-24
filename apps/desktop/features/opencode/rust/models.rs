//! The model list of Settings > Agent > OpenCode: `GET /api/model` (and the provider names of
//! `GET /api/provider`) read into the rows the models table shows. Pure; the raw replies carry a
//! provider's `headers` and `settings` (an organisation id, base URLs), which are never read here
//! and never leave the Rust side.

use super::opencode_api::ModelRef;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;

/// One row of the table. Prices are USD per million tokens, the first price tier (the one a short
/// context pays).
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct OpencodeModel {
    /// `provider/model`: what Writer stores and shows, the same slug as `ModelRef::slug`.
    pub id: String,
    pub provider_id: String,
    /// The provider's name (its id when the server gave none).
    pub provider: String,
    pub name: String,
    /// Context window in tokens, `None` when the server did not say.
    pub context: Option<f64>,
    pub input_cost: Option<f64>,
    pub output_cost: Option<f64>,
    /// Costs nothing to use: both prices are zero.
    pub free: bool,
    /// Takes images, PDFs and calls tools, as the server says.
    pub image: bool,
    pub pdf: bool,
    pub tools: bool,
    /// Has effort levels (variants).
    pub reasoning: bool,
    /// The effort levels, in the server's order.
    pub variants: Vec<String>,
    /// The server's own switch and status: a model that is off or retired is not offered.
    pub available: bool,
}

fn provider_names(providers: &Value) -> HashMap<String, String> {
    rows(providers)
        .filter_map(|p| {
            Some((
                p["id"].as_str()?.to_string(),
                p["name"].as_str()?.to_string(),
            ))
        })
        .collect()
}

/// The rows of a reply: `{data: [..]}` or a bare array.
fn rows(reply: &Value) -> impl Iterator<Item = &Value> {
    reply
        .get("data")
        .unwrap_or(reply)
        .as_array()
        .into_iter()
        .flatten()
}

/// The models of `GET /api/model` with the provider names of `GET /api/provider`, sorted by
/// provider, then name. Entries with no id are skipped; an entry that is not a chat model is too.
pub fn from_replies(models: &Value, providers: &Value) -> Vec<OpencodeModel> {
    let names = provider_names(providers);
    let mut out: Vec<OpencodeModel> = rows(models)
        .filter(|m| m["type"].as_str().is_none_or(|t| t == "chat"))
        .filter_map(|m| {
            let id = m["id"].as_str()?;
            let provider_id = m["providerID"].as_str()?;
            let price = |key: &str| m["cost"][0][key].as_f64();
            let (input_cost, output_cost) = (price("input"), price("output"));
            let accepts = |kind: &str| {
                m["capabilities"]["input"]
                    .as_array()
                    .is_some_and(|a| a.iter().any(|v| v == kind))
            };
            let variants: Vec<String> = m["variants"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|v| v["id"].as_str().map(String::from))
                .collect();
            Some(OpencodeModel {
                id: ModelRef {
                    id: id.to_string(),
                    providerID: provider_id.to_string(),
                    variant: None,
                }
                .slug(),
                provider_id: provider_id.to_string(),
                provider: names
                    .get(provider_id)
                    .cloned()
                    .unwrap_or_else(|| provider_id.to_string()),
                name: m["name"].as_str().unwrap_or(id).to_string(),
                context: m["limit"]["context"].as_f64().filter(|c| *c > 0.0),
                input_cost,
                output_cost,
                free: input_cost == Some(0.0) && output_cost == Some(0.0),
                image: accepts("image"),
                pdf: accepts("pdf"),
                tools: m["capabilities"]["tools"] == true,
                reasoning: !variants.is_empty(),
                variants,
                available: m["enabled"] != false
                    && m["status"].as_str().is_none_or(|s| s == "active"),
            })
        })
        .collect();
    out.sort_by(|a, b| {
        a.provider
            .to_lowercase()
            .cmp(&b.provider.to_lowercase())
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    out
}

/// A saved "always" rule of OpenCode (`psv_`): what the user allowed for good.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SavedRule {
    pub id: String,
    pub action: String,
    pub resource: String,
}

/// What Settings shows of the saved rules: the vault's project's, or every project's when the
/// vault's is not known yet (then the list is read-only).
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SavedRules {
    pub rules: Vec<SavedRule>,
    /// `rules` are the vault's project's (they can be removed); `false`: every project's.
    pub project_scoped: bool,
}

/// The rules the user saved with "Always allow".
///
/// `project` limits them to one project's (the vault's); `None` keeps every project's.
pub fn saved_rules(reply: &Value, project: Option<&str>) -> Vec<SavedRule> {
    rows(reply)
        .filter(|r| project.is_none_or(|p| r["projectID"].as_str() == Some(p)))
        .filter_map(|r| {
            Some(SavedRule {
                id: r["id"].as_str()?.to_string(),
                action: r["action"].as_str()?.to_string(),
                resource: r["resource"].as_str().unwrap_or("*").to_string(),
            })
        })
        .collect()
}

/// The project id in the reply of `GET /api/location` (`Location.PublicInfo`). A project whose
/// folder (or canonical folder) is the filesystem root is the catch-all of folders that belong to
/// no project: it is no project of this vault, so none is known.
pub fn project_of_location(reply: &Value) -> Option<String> {
    let info = reply.get("data").unwrap_or(reply);
    let project = &info["project"];
    let is_root = |key: &str| {
        project[key]
            .as_str()
            .is_some_and(|d| std::path::Path::new(d).parent().is_none())
    };
    if is_root("canonical") || is_root("directory") {
        return None;
    }
    project["id"].as_str().map(str::to_string)
}

/// The project of the vault at `root` in `GET /api/project`, when the server could not be asked
/// for it: the one whose folder (or one of whose sandboxes) it is, else the one with the longest
/// folder that holds it (a vault inside a git repository belongs to the repository's project). A
/// folder that is the filesystem root is a catch-all, never a match: it would hand every vault the
/// rules of every other. `None` when no project holds it.
pub fn project_of(reply: &Value, root: &std::path::Path) -> Option<String> {
    let inside = |dir: &str| root.starts_with(dir) && std::path::Path::new(dir).parent().is_some();
    rows(reply)
        .filter_map(|p| {
            let id = p["id"].as_str()?;
            let own = std::iter::once(p["canonical"].as_str())
                .chain(p["sandboxes"].as_array()?.iter().map(Value::as_str))
                .flatten()
                .filter(|d| !d.is_empty() && inside(d))
                .map(str::len)
                .max()?;
            Some((own, id))
        })
        .max_by_key(|(len, _)| *len)
        .map(|(_, id)| id.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture() -> (Value, Value) {
        let rest: Value =
            serde_json::from_str(include_str!("../fixtures/rest.json")).expect("rest.json");
        (
            rest["models"]["body"].clone(),
            rest["provider"]["body"].clone(),
        )
    }

    #[test]
    fn the_recorded_list_becomes_rows_with_the_providers_name_and_the_first_price() {
        let (models, providers) = fixture();
        let rows = from_replies(&models, &providers);
        assert_eq!(rows.len(), models["data"].as_array().unwrap().len());
        let sonnet = rows
            .iter()
            .find(|m| m.id == "opencode/claude-sonnet-5-5")
            .unwrap();
        assert_eq!(sonnet.provider, "Default / OpenCode");
        assert_eq!(
            (sonnet.input_cost, sonnet.output_cost),
            (Some(2.0), Some(10.0))
        );
        assert!(sonnet.image && sonnet.pdf && sonnet.tools && sonnet.reasoning && !sonnet.free);
        assert_eq!(sonnet.variants, ["low", "medium", "high", "xhigh", "max"]);
        assert_eq!(sonnet.context, Some(1_000_000.0));
        // a context tier does not change the price shown: the first tier is the short context's
        let gpt = rows.iter().find(|m| m.id == "opencode/gpt-6-sol").unwrap();
        assert_eq!(gpt.input_cost, Some(2.0));
    }

    #[test]
    fn free_means_both_prices_are_zero_and_a_model_without_variants_has_no_effort() {
        let (models, providers) = fixture();
        let rows = from_replies(&models, &providers);
        let free = rows.iter().find(|m| m.id == "opencode/beam-free").unwrap();
        assert!(free.free && free.reasoning);
        let plain = rows.iter().find(|m| m.id == "opencode/big-pickle").unwrap();
        assert!(plain.free && !plain.reasoning && plain.variants.is_empty());
        assert!(rows.iter().filter(|m| m.free).count() > 3);
    }

    #[test]
    fn rows_are_sorted_and_skip_what_has_no_id_or_is_not_a_chat_model() {
        let models = json!({"data": [
            {"id": "b", "providerID": "p", "name": "Zed"},
            {"id": "a", "providerID": "p", "name": "Alpha"},
            {"providerID": "p", "name": "no id"},
            {"id": "img", "providerID": "p", "type": "image"},
            {"id": "off", "providerID": "p", "name": "Off", "enabled": false},
            {"id": "old", "providerID": "p", "name": "Old", "status": "deprecated"},
        ]});
        let rows = from_replies(&models, &json!({"data": []}));
        assert_eq!(
            rows.iter().map(|m| m.name.as_str()).collect::<Vec<_>>(),
            ["Alpha", "Off", "Old", "Zed"]
        );
        assert_eq!(rows[0].provider, "p");
        assert!(rows[0].input_cost.is_none() && !rows[0].free);
        assert!(!rows[1].available && !rows[2].available && rows[3].available);
    }

    #[test]
    fn nothing_of_a_providers_headers_or_settings_is_read() {
        // the names come from `id` and `name` only; the secret-looking fields are never touched
        let providers = json!({"data": [{
            "id": "p", "name": "P", "activation": "enabled",
            "headers": {"x-org": "org-secret"}, "settings": {"apiKey": "sk-secret"}
        }]});
        let rows = from_replies(
            &json!({"data": [{"id": "m", "providerID": "p"}]}),
            &providers,
        );
        assert_eq!(rows[0].provider, "P");
        assert!(!format!("{rows:?}").contains("secret"));
    }

    #[test]
    fn saved_rules_read_the_id_action_and_resource() {
        let reply = json!({"data": [
            {"id": "psv_1", "projectID": "prj_1", "action": "shell", "resource": "echo *"},
            {"action": "edit"},
        ]});
        assert_eq!(
            saved_rules(&reply, None),
            vec![SavedRule {
                id: "psv_1".into(),
                action: "shell".into(),
                resource: "echo *".into()
            }]
        );
        assert!(saved_rules(&json!({}), None).is_empty());
    }
}

#[cfg(test)]
mod project_tests {
    use super::*;
    use serde_json::json;
    use std::path::Path;

    fn projects() -> Value {
        json!({"data": [
            {"id": "prj_global", "canonical": "/", "sandboxes": []},
            {"id": "prj_repo", "canonical": "/work/repo", "sandboxes": ["/work/repo-wt"]},
            {"id": "prj_other", "canonical": "/work/other", "sandboxes": []},
            {"id": "prj_blank", "canonical": "", "sandboxes": []},
        ]})
    }

    #[test]
    fn the_vaults_project_is_the_one_that_holds_its_folder_and_the_closest_wins() {
        let p = projects();
        // the vault is the project's folder, or inside it (a vault in a repository)
        assert_eq!(
            project_of(&p, Path::new("/work/repo")).as_deref(),
            Some("prj_repo")
        );
        assert_eq!(
            project_of(&p, Path::new("/work/repo/notes")).as_deref(),
            Some("prj_repo")
        );
        // a sandbox of a project is the project
        assert_eq!(
            project_of(&p, Path::new("/work/repo-wt/notes")).as_deref(),
            Some("prj_repo")
        );
        // a folder no project holds is no project's: the catch-all at "/" never matches, and a
        // sibling does not either
        assert_eq!(project_of(&p, Path::new("/work/third")), None);
        assert_eq!(project_of(&p, Path::new("/")), None);
        // a blank folder holds nothing; with no project at all there is none
        assert_eq!(project_of(&json!({"data": []}), Path::new("/x")), None);
        assert_eq!(
            project_of(
                &json!({"data": [{"id": "p", "canonical": "", "sandboxes": []}]}),
                Path::new("/x")
            ),
            None
        );
    }

    #[test]
    fn the_servers_own_answer_for_the_location_is_read_wrapped_or_bare() {
        let bare = json!({"directory": "/v", "project": {"id": "prj_a", "directory": "/v", "canonical": "/v"}});
        assert_eq!(project_of_location(&bare).as_deref(), Some("prj_a"));
        assert_eq!(
            project_of_location(&json!({"data": bare})).as_deref(),
            Some("prj_a")
        );
        assert_eq!(project_of_location(&json!({"directory": "/v"})), None);
        // the catch-all project at the filesystem root is no project of the vault
        for key in ["canonical", "directory"] {
            let mut root = bare.clone();
            root["project"][key] = json!("/");
            assert_eq!(project_of_location(&root), None, "{key}");
        }
    }

    #[test]
    fn the_rules_of_two_projects_are_told_apart() {
        let reply = json!({"data": [
            {"id": "psv_mine", "projectID": "prj_repo", "action": "shell", "resource": "ls *"},
            {"id": "psv_foreign", "projectID": "prj_other", "action": "edit", "resource": "*"},
        ]});
        let ids = |p| {
            saved_rules(&reply, p)
                .into_iter()
                .map(|r| r.id)
                .collect::<Vec<_>>()
        };
        assert_eq!(ids(Some("prj_repo")), ["psv_mine"]);
        assert_eq!(ids(Some("prj_other")), ["psv_foreign"]);
        assert_eq!(ids(Some("prj_none")), Vec::<String>::new());
        assert_eq!(ids(None), ["psv_mine", "psv_foreign"]);
    }
}
