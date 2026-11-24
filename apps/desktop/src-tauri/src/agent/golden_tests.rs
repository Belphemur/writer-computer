//! The one golden compare-or-write of the agent's tests: `<dir>/<name>.events.json` holds what a
//! mapper produced; `WRITER_UPDATE_GOLDEN=1 cargo test golden` rewrites it deliberately.

use super::events::AgentEvent;
use std::path::Path;

/// Compares `actual` with the golden `name` in `dir` (writing it first when asked to).
pub(crate) fn check(dir: &Path, name: &str, actual: &str) {
    let path = dir.join(format!("{name}.events.json"));
    if std::env::var_os("WRITER_UPDATE_GOLDEN").is_some() {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(&path, actual).unwrap();
    }
    let expected = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("{}: {e} (run with WRITER_UPDATE_GOLDEN=1)", path.display()));
    assert_eq!(actual, expected, "golden drift in {name}");
}

/// The wire `type` of each event, in order (the neutral kinds, read from their one serialisation).
pub(crate) fn kinds(events: &[AgentEvent]) -> Vec<String> {
    events
        .iter()
        .map(|e| {
            serde_json::to_value(e).unwrap()["type"]
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect()
}
