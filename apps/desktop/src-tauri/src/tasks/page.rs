//! The sections of the Tasks page: each a built-in base over `rows: tasks`, rendered by the
//! Bases view (SPECs/tasks-spec.md 6). One list, here, for the page and its tests.

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, specta::Type)]
pub struct Section {
    pub id: &'static str,
    pub label: &'static str,
    /// The `.base` text.
    pub base: &'static str,
}

macro_rules! section {
    ($id:literal, $label:literal, $filters:literal, $extra:literal) => {
        Section {
            id: $id,
            label: $label,
            base: concat!(
                "rows: tasks\nfilters:\n  and:\n",
                $filters,
                "views:\n  - type: table\n    name: ",
                $label,
                "\n    order:\n      - task.checked\n      - task.description\n      - task.priority\n      - task.due\n      - file.name\n",
                $extra
            ),
        }
    };
}

pub const SECTIONS: [Section; 5] = [
    section!(
        "today",
        "Today",
        "    - '!task.checked'\n    - '(task.due != null && task.due == today()) || (task.scheduled != null && task.scheduled == today())'\n",
        "    sort:\n      - property: task.urgency\n        direction: DESC\n"
    ),
    section!(
        "upcoming",
        "Upcoming",
        "    - '!task.checked'\n    - 'task.due != null && task.due > today()'\n",
        "    sort:\n      - property: task.due\n        direction: ASC\n"
    ),
    section!(
        "overdue",
        "Overdue",
        "    - '!task.checked'\n    - 'task.due != null && task.due < today()'\n",
        "    sort:\n      - property: task.due\n        direction: ASC\n"
    ),
    section!(
        "no-date",
        "No date",
        "    - '!task.checked'\n    - task.due == null\n    - task.scheduled == null\n",
        "    sort:\n      - property: file.path\n        direction: ASC\n"
    ),
    section!(
        "by-folder",
        "By folder",
        "    - '!task.checked'\n",
        "    groupBy:\n      property: file.folder\n      direction: ASC\n    sort:\n      - property: file.path\n        direction: ASC\n"
    ),
];

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bases::document::{Document, RowKind};

    #[test]
    fn every_section_is_a_task_base_with_a_view_of_its_name() {
        for s in SECTIONS {
            let doc = Document::parse(s.base).unwrap_or_else(|e| panic!("{}: {e:?}", s.id));
            assert!(doc.warnings.is_empty(), "{}: {:?}", s.id, doc.warnings);
            assert_eq!(doc.rows, RowKind::Tasks, "{}", s.id);
            assert_eq!(doc.views[0].name, s.label);
        }
        let ids: Vec<_> = SECTIONS.iter().map(|s| s.id).collect();
        assert_eq!(
            ids,
            ["today", "upcoming", "overdue", "no-date", "by-folder"]
        );
    }
}
