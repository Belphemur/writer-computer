use std::{fs, path::Path};

/// Built-in features (SPECs/builtin-plugins-spec.md): `apps/desktop/features/<id>/feature.json` names the
/// feature and its `rust.commands`; each becomes an inlined Tauri plugin so its commands get
/// `<id>:allow-<command>` permissions and are called as `plugin:<id>|<command>`. The capability
/// that grants them lives in `capabilities/features/<id>.json`: tauri-build's default pattern
/// (`./capabilities/**/*`) already picks it up, so there is no capability code here.
fn features(attrs: tauri_build::Attributes) -> tauri_build::Attributes {
    let dir = Path::new("../features");
    println!("cargo::rerun-if-changed={}", dir.display());
    let Ok(entries) = fs::read_dir(dir) else {
        return attrs;
    };
    let mut manifests: Vec<_> = entries
        .flatten()
        .map(|e| e.path().join("feature.json"))
        .filter(|p| p.is_file())
        .collect();
    manifests.sort();
    manifests.into_iter().fold(attrs, |attrs, path| {
        println!("cargo::rerun-if-changed={}", path.display());
        let raw = fs::read_to_string(&path).unwrap();
        let m: serde_json::Value = serde_json::from_str(&raw)
            .unwrap_or_else(|e| panic!("{}: not valid JSON: {e}", path.display()));
        // The build script is short-lived: leaking gives the `&'static` the API asks for.
        let leak = |s: &str| -> &'static str { Box::leak(s.to_owned().into_boxed_str()) };
        let id = leak(m["id"].as_str().expect("feature.json: id"));
        let commands: Vec<&'static str> = m["rust"]["commands"]
            .as_array()
            .map(|a| {
                a.iter()
                    .map(|c| leak(c.as_str().expect("command name")))
                    .collect()
            })
            .unwrap_or_default();
        attrs.plugin(
            id,
            tauri_build::InlinedPlugin::new()
                .commands(Box::leak(commands.into_boxed_slice()))
                .default_permission(tauri_build::DefaultPermissionRule::AllowAllCommands),
        )
    })
}

fn main() {
    // `telemetry.rs` reads these with `option_env!`. Cargo tracks that through
    // dep-info for the crate itself; declaring them here as well makes the
    // dependency explicit and covers the build script's own outputs.
    println!("cargo::rerun-if-env-changed=WRITER_POSTHOG_KEY");
    println!("cargo::rerun-if-env-changed=WRITER_POSTHOG_HOST");

    tauri_build::try_build(features(tauri_build::Attributes::new())).unwrap();
}
