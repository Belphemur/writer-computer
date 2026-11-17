use super::*;
use tempfile::TempDir;

const ID: &str = "5328964b-5fe4-4e06-8843-5cf92bdc9e7c";
const ID2: &str = "aaaaaaaa-0000-4000-8000-000000000002";

fn fixture(name: &str) -> String {
    let p = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../tests/fixtures/agent-chat-notes")
        .join(name);
    std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()))
}

fn vault() -> (TempDir, PathBuf) {
    let d = TempDir::new().unwrap();
    let root = d.path().canonicalize().unwrap();
    std::fs::create_dir_all(root.join("Projects/Demo")).unwrap();
    (d, root)
}

/// The basic golden note re-identified, with chosen frontmatter edits.
fn note(id: &str, project: Option<&str>, title: &str, updated: i64) -> String {
    let mut t = fixture("basic.md").replace(ID, id);
    t = t.replace("Plan the Q4 review", title);
    t = t.replace(
        "writer-chat-updated: 1794906785123",
        &format!("writer-chat-updated: {updated}"),
    );
    match project {
        Some(p) => t.replace("Projects/Demo", p),
        None => t.replace("writer-chat-project-path: Projects/Demo\n", ""),
    }
}

fn all(root: &Path) -> Vec<ChatSummary> {
    list(
        root,
        &ListOptions {
            scope: ListScope::All,
            include_archived: true,
            query: None,
        },
    )
    .unwrap()
}

#[test]
fn golden_notes_parse_to_the_shared_json() {
    for name in ["basic", "escape", "props", "changes"] {
        let (meta, body) = parse_note(&fixture(&format!("{name}.md"))).unwrap();
        let golden: Value = serde_json::from_str(&fixture(&format!("{name}.parsed.json"))).unwrap();
        assert_eq!(
            serde_json::to_value(&meta).unwrap(),
            golden["meta"],
            "{name} meta"
        );
        assert_eq!(
            serde_json::to_value(&body.turns).unwrap(),
            golden["turns"],
            "{name} turns"
        );
        assert_eq!(
            body.trimmed as u64,
            golden["trimmed"].as_u64().unwrap(),
            "{name} trimmed"
        );
    }
}

#[test]
fn escape_round_trip_and_structure_lines() {
    let t = "a\n## user · x\n> context: y\n<!-- writer:z\n\u{200B}## assistant · q\nplain > q";
    let e = escape_text(t);
    assert_eq!(e.split('\n').filter(|l| l.starts_with(ESCAPE)).count(), 4);
    let back: Vec<&str> = e.split('\n').map(unescape_line).collect();
    assert_eq!(back.join("\n"), t);
}

#[test]
fn names_and_ids() {
    assert!(is_valid_chat_id(ID));
    for bad in [
        "",
        "../x",
        "5328964b-5fe4-4e06-8843-5cf92bdc9e7",
        "zzzzzzzz-5fe4-4e06-8843-5cf92bdc9e7c",
        "5328964b/5fe4/4e06/8843/5cf92bdc9e7c",
    ] {
        assert!(!is_valid_chat_id(bad), "{bad}");
    }
    assert_eq!(slugify("Plan the Q4 review!"), "plan-the-q4-review");
    assert_eq!(slugify("日本語"), "chat");
    assert!(slugify(&"a".repeat(100)).len() <= 40);
    assert_eq!(
        file_name(1794906725123, "Plan the Q4 review", ID),
        "2026-11-17-0912-plan-the-q4-review-5328964b.md"
    );
}

#[test]
fn save_creates_in_the_project_and_loads_back() {
    let (_d, root) = vault();
    let md = note(
        ID,
        Some("Projects/Demo"),
        "Plan the Q4 review",
        1794906785123,
    );
    let s = save(&root, ID, &md, None).unwrap();
    assert_eq!(
        s.path,
        "Projects/Demo/.chats/2026-11-17-0912-plan-the-q4-review-5328964b.md"
    );
    assert_eq!(s.project_path.as_deref(), Some("Projects/Demo"));
    assert_eq!(s.turn_count, 1);
    assert_eq!(
        s.preview.as_deref(),
        Some("Summarise the notes tagged #client.")
    );
    let (s2, text) = load(&root, ID).unwrap();
    assert_eq!(s, s2);
    assert_eq!(text, md);
    // No temp files left behind.
    let names: Vec<_> = std::fs::read_dir(root.join("Projects/Demo/.chats"))
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(names.len(), 1);
}

#[test]
fn chats_without_a_project_live_under_dot_writer() {
    let (_d, root) = vault();
    let s = save(&root, ID, &note(ID, None, "Loose", 5), None).unwrap();
    assert!(s.path.starts_with(".writer/chats/"), "{}", s.path);
    assert_eq!(s.project_path, None);
    let only_root = list(
        &root,
        &ListOptions {
            scope: ListScope::Project(None),
            include_archived: false,
            query: None,
        },
    )
    .unwrap();
    assert_eq!(only_root.len(), 1);
}

#[test]
fn chat_notes_are_invisible_to_the_index() {
    assert!(!crate::index::paths::is_indexable_rel(Path::new(
        "Projects/Demo/.chats/x.md"
    )));
    assert!(!crate::index::paths::is_indexable_rel(Path::new(
        ".writer/chats/x.md"
    )));
}

#[test]
fn the_window_may_open_a_chat_note_under_a_dot_folder() {
    // "Reveal chat note": the editor reads it through `read_file`, which only needs the path to
    // be inside the workspace root (`WorkspaceState::authorize_path`), hidden or not.
    let (_d, root) = vault();
    let s = save(&root, ID, &note(ID, Some("Projects/Demo"), "T", 1), None).unwrap();
    let state = crate::state::WorkspaceState::default();
    *state.workspace_root.write() = Some(root.clone());
    let abs = root.join(&s.path);
    assert!(state.authorize_path(&abs).is_ok());
    assert!(crate::commands::fs::read_file_impl(abs.to_str().unwrap()).is_ok());
}

#[test]
fn save_rejects_mismatched_ids_missing_frontmatter_and_escaping_projects() {
    let (_d, root) = vault();
    assert!(save(&root, ID2, &note(ID, None, "x", 1), None).is_err());
    assert!(save(&root, ID, "just text", None).is_err());
    assert!(save(&root, "../../evil", "x", None).is_err());
    let escape = note(ID, Some("../outside"), "x", 1);
    assert!(save(&root, ID, &escape, None).is_err());
    let missing = note(ID, Some("Projects/Nope"), "x", 1);
    assert!(matches!(
        save(&root, ID, &missing, None),
        Err(ChatStoreError::NotFound(_))
    ));
    assert!(!root.join("../outside").exists());
}

#[test]
fn save_keeps_user_properties_and_action_state() {
    let (_d, root) = vault();
    save(
        &root,
        ID,
        &note(ID, Some("Projects/Demo"), "First title", 10),
        None,
    )
    .unwrap();
    // The user adds a property and a comment by hand, then renames and pins from the list.
    let abs = find(&root, ID).unwrap().unwrap();
    let hand = std::fs::read_to_string(&abs).unwrap().replacen(
        "writer-chat-pinned: false\n",
        "writer-chat-pinned: false\nowner: Ada # mine\n",
        1,
    );
    std::fs::write(&abs, hand).unwrap();
    action(&root, ID, ChatAction::Pin, None, true).unwrap();
    let renamed = action(&root, ID, ChatAction::Rename, Some("  My   plan "), true)
        .unwrap()
        .unwrap();
    assert_eq!(renamed.title, "My plan");
    assert!(
        renamed.path.ends_with("-my-plan-5328964b.md"),
        "{}",
        renamed.path
    );
    // A stale pane saves with the old title, unpinned, and new content.
    let mut stale = note(ID, Some("Projects/Demo"), "First title", 99);
    stale.push_str("\n## user · 2026-11-17 10:00\n\nnew message\n");
    let s = save(&root, ID, &stale, None).unwrap();
    assert_eq!(s.title, "My plan");
    assert!(s.pinned);
    assert_eq!(s.updated_at, 99);
    let (_, text) = load(&root, ID).unwrap();
    assert!(text.contains("owner: Ada # mine"));
    assert!(text.contains("new message"));
    assert!(text.contains("writer-chat-renamed: true"));
    assert_eq!(text.matches("writer-chat-id:").count(), 1);
}

#[test]
fn title_follows_the_pane_until_renamed() {
    let (_d, root) = vault();
    save(&root, ID, &note(ID, None, "Draft title", 1), None).unwrap();
    let s = save(&root, ID, &note(ID, None, "Better title", 2), None).unwrap();
    assert_eq!(s.title, "Better title");
}

#[test]
fn title_hint_names_a_chat_without_one() {
    let (_d, root) = vault();
    let md = note(ID, None, "x", 1).replace("writer-chat-title: x\n", "");
    let s = save(&root, ID, &md, Some("From hint")).unwrap();
    assert_eq!(s.title, "From hint");
}

#[test]
fn archive_pin_list_filters_and_search() {
    let (_d, root) = vault();
    save(
        &root,
        ID,
        &note(ID, Some("Projects/Demo"), "Quarterly review", 30),
        None,
    )
    .unwrap();
    save(&root, ID2, &note(ID2, None, "Groceries", 20), None).unwrap();
    let ids: Vec<_> = all(&root).iter().map(|c| c.chat_id.clone()).collect();
    assert_eq!(ids, [ID, ID2], "newest update first");

    let a = action(&root, ID2, ChatAction::Archive, None, true)
        .unwrap()
        .unwrap();
    assert!(a.archived);
    let opts = |include_archived, query: Option<&str>| ListOptions {
        scope: ListScope::All,
        include_archived,
        query: query.map(String::from),
    };
    assert_eq!(list(&root, &opts(false, None)).unwrap().len(), 1);
    assert_eq!(list(&root, &opts(true, None)).unwrap().len(), 2);
    assert!(
        !action(&root, ID2, ChatAction::Unarchive, None, true)
            .unwrap()
            .unwrap()
            .archived
    );

    // Title and first message are searched, every word must match, case-insensitively.
    assert_eq!(
        list(&root, &opts(true, Some("QUARTERLY"))).unwrap().len(),
        2 - 1
    );
    assert_eq!(
        list(&root, &opts(true, Some("notes tagged")))
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        list(&root, &opts(true, Some("quarterly nothing")))
            .unwrap()
            .len(),
        0
    );

    let p = action(&root, ID, ChatAction::Pin, None, true)
        .unwrap()
        .unwrap();
    assert!(p.pinned);
    assert!(
        !action(&root, ID, ChatAction::Unpin, None, true)
            .unwrap()
            .unwrap()
            .pinned
    );
}

#[test]
fn delete_removes_the_note() {
    let (_d, root) = vault();
    let s = save(&root, ID, &note(ID, None, "Gone", 1), None).unwrap();
    assert_eq!(
        action(&root, ID, ChatAction::Delete, None, true).unwrap(),
        None
    );
    assert!(!root.join(s.path).exists());
    assert!(matches!(load(&root, ID), Err(ChatStoreError::NotFound(_))));
    assert!(matches!(
        action(&root, ID, ChatAction::Pin, None, true),
        Err(ChatStoreError::NotFound(_))
    ));
}

#[test]
fn rename_validates_the_title() {
    let (_d, root) = vault();
    save(&root, ID, &note(ID, None, "T", 1), None).unwrap();
    assert!(action(&root, ID, ChatAction::Rename, Some("   "), true).is_err());
    assert!(action(&root, ID, ChatAction::Rename, None, true).is_err());
}

#[test]
fn find_survives_a_cold_cache_and_ignores_foreign_files() {
    let (_d, root) = vault();
    let s = save(&root, ID, &note(ID, Some("Projects/Demo"), "T", 1), None).unwrap();
    forget(&root, ID);
    assert_eq!(find(&root, ID).unwrap().unwrap(), root.join(&s.path));
    // A foreign markdown file in a chats folder and a non-chat note do not break listing.
    std::fs::write(root.join("Projects/Demo/.chats/notes.md"), "# hello\n").unwrap();
    std::fs::write(
        root.join("Projects/Demo/.chats/broken.md"),
        "---\n: : :\n---\n",
    )
    .unwrap();
    assert_eq!(all(&root).len(), 1);
    // Hidden folders other than .chats and node_modules are not walked.
    std::fs::create_dir_all(root.join("node_modules/x/.chats")).unwrap();
    std::fs::write(
        root.join("node_modules/x/.chats/a-5328964b.md"),
        note(ID2, None, "N", 1),
    )
    .unwrap();
    assert_eq!(all(&root).len(), 1);
}

#[test]
fn unicode_title_and_cut_head_reads() {
    let (_d, root) = vault();
    let md = note(ID, None, "Café ☕ 日本語", 1);
    let s = save(&root, ID, &md, None).unwrap();
    assert_eq!(s.title, "Café ☕ 日本語");
    assert!(s.path.contains("-caf-5328964b.md"), "{}", s.path);
    // A head cut inside a multi-byte character still reads.
    let abs = root.join(&s.path);
    assert!(read_head(&abs, 700).is_ok());
}

fn big_note(turns: usize) -> String {
    let mut t = note(ID, None, "Big", 1);
    for i in 0..turns {
        t.push_str(&format!(
            "\n## user · 2026-11-17 09:12\n<!-- writer:msg {{\"id\":\"u{i}\",\"at\":{i}}} -->\n\n{}\n",
            "x".repeat(2000)
        ));
    }
    t
}

#[test]
fn notes_are_bounded_oldest_first() {
    let text = big_note(100);
    let bounded = bound_note(&text, 20_000);
    assert!(bounded.len() <= 20_000);
    let (_, body) = parse_note(&bounded).unwrap();
    assert!(body.trimmed > 0);
    assert_eq!(
        body.trimmed as usize + body.turns.len(),
        102,
        "2 from the golden note + 100"
    );
    assert_eq!(body.turns.last().unwrap().id, "u99", "newest kept");
    // Trimming twice accumulates.
    let again = bound_note(
        &format!(
            "{bounded}\n## user · 2026-11-17 09:12\n\n{}\n",
            "y".repeat(8000)
        ),
        20_000,
    );
    let (_, body2) = parse_note(&again).unwrap();
    assert!(body2.trimmed > body.trimmed);
    // Frontmatter survives.
    assert!(again.starts_with("---\nwriter-chat-id:"));
}

#[test]
fn a_single_oversized_message_is_cut_not_dropped() {
    let mut t = note(ID, None, "One", 1);
    t.push_str(&format!(
        "\n## user · 2026-11-17 09:12\n\n{}\n",
        "é".repeat(50_000)
    ));
    let first = t.find("\n## user").unwrap();
    let only_big = format!("{}{}", &t[..first], &t[t.rfind("\n## user").unwrap()..]);
    let b = bound_note(&only_big, 5_000);
    assert!(b.len() <= 5_000);
    assert!(b.contains("writer:truncated") || b.contains("writer:trimmed"));
    assert!(parse_note(&b).is_ok());
}

#[test]
fn save_enforces_the_bound() {
    let (_d, root) = vault();
    let s = save(&root, ID, &big_note(700), None).unwrap();
    let len = std::fs::metadata(root.join(&s.path)).unwrap().len() as usize;
    assert!(len <= MAX_NOTE_BYTES);
}

#[test]
fn replay_seed_is_capped_and_keeps_the_newest() {
    let mut t = note(ID, None, "R", 1);
    for i in 0..60 {
        let role = if i % 2 == 0 { "user" } else { "assistant" };
        t.push_str(&format!(
            "\n## {role} · 2026-11-17 09:12\n<!-- writer:msg {{\"id\":\"r{i}\",\"at\":{i}}} -->\n\nmessage {i} {}\n",
            "w".repeat(400)
        ));
    }
    let seed = replay_seed(&t, 1_000);
    assert!(seed.turns_included > 0 && seed.turns_included < seed.turns_total);
    assert!(seed.text.contains("message 59"));
    assert!(!seed.text.contains("message 3 "));
    assert!(seed.estimated_tokens <= 1_100, "{}", seed.estimated_tokens);
    assert!(seed.text.starts_with("[Resumed from notes]"));
    let full = replay_seed(&fixture("basic.md"), DEFAULT_REPLAY_TOKENS);
    assert_eq!(full.turns_included, full.turns_total);
    assert!(full.text.contains("User: Summarise the notes"));
    assert!(full.text.contains("Assistant: Here is the summary."));
    assert!(!full.text.contains("writer:tools"));
}

#[test]
fn missing_session_errors_are_recognised_loosely() {
    for m in [
        "No conversation found with session ID: abc",
        "Error: conversation not found",
        "Session abc123 not found",
    ] {
        assert!(is_session_missing(m), "{m}");
    }
    for m in ["rate limited", "Invalid API key", ""] {
        assert!(!is_session_missing(m), "{m}");
    }
}

#[test]
fn transcript_markdown_has_no_metadata() {
    let md = transcript_markdown(&fixture("basic.md"));
    assert!(md.starts_with("**user**\n\nSummarise"));
    assert!(!md.contains("writer-chat"));
    assert!(!md.contains("context:"));
}

#[test]
fn auto_title_applies_once_survives_a_stale_save_and_renames_the_file() {
    let (_d, root) = vault();
    save(&root, ID, &note(ID, None, "First message cut", 1), None).unwrap();
    let s = action(
        &root,
        ID,
        ChatAction::AutoTitle,
        Some("Q4 review plan"),
        true,
    )
    .unwrap()
    .unwrap();
    assert_eq!(s.title, "Q4 review plan");
    assert_eq!(s.title_source, TitleSource::Auto);
    assert!(
        s.path.ends_with("-q4-review-plan-5328964b.md"),
        "{}",
        s.path
    );
    // one automatic attempt: a second one changes nothing
    let again = action(&root, ID, ChatAction::AutoTitle, Some("Other words"), true)
        .unwrap()
        .unwrap();
    assert_eq!(again.title, "Q4 review plan");
    // a pane that still has the placeholder saves: the title stays
    let stale = save(&root, ID, &note(ID, None, "First message cut", 5), None).unwrap();
    assert_eq!(stale.title, "Q4 review plan");
    assert_eq!(stale.title_source, TitleSource::Auto);
    let (_, text) = load(&root, ID).unwrap();
    assert_eq!(text.matches("writer-chat-title-auto: true").count(), 1);
    assert!(!text.contains("writer-chat-renamed"));
}

#[test]
fn auto_title_never_overwrites_a_user_title_and_a_user_rename_beats_an_auto_one() {
    let (_d, root) = vault();
    save(&root, ID, &note(ID, None, "Draft", 1), None).unwrap();
    action(&root, ID, ChatAction::Rename, Some("Mine"), true).unwrap();
    let s = action(&root, ID, ChatAction::AutoTitle, Some("Robot title"), true)
        .unwrap()
        .unwrap();
    assert_eq!(s.title, "Mine");
    assert_eq!(s.title_source, TitleSource::User);

    save(&root, ID2, &note(ID2, None, "Draft", 1), None).unwrap();
    action(&root, ID2, ChatAction::AutoTitle, Some("Robot title"), true).unwrap();
    let r = action(&root, ID2, ChatAction::Rename, Some("Human title"), true)
        .unwrap()
        .unwrap();
    assert_eq!(r.title, "Human title");
    assert_eq!(r.title_source, TitleSource::User);
    assert!(action(&root, ID2, ChatAction::AutoTitle, Some("  "), true).is_ok());
}

#[test]
fn auto_title_rejects_an_empty_title_and_keeps_the_placeholder() {
    let (_d, root) = vault();
    save(&root, ID, &note(ID, None, "Draft", 1), None).unwrap();
    assert!(action(&root, ID, ChatAction::AutoTitle, Some("  "), true).is_err());
    let s = all(&root).pop().unwrap();
    assert_eq!(s.title, "Draft");
    assert_eq!(s.title_source, TitleSource::None);
}

#[test]
fn regenerate_overwrites_a_user_title_as_an_auto_one_and_a_later_rename_wins() {
    let (_d, root) = vault();
    save(&root, ID, &note(ID, None, "Draft", 1), None).unwrap();
    action(&root, ID, ChatAction::Rename, Some("Mine"), true).unwrap();
    let s = action(
        &root,
        ID,
        ChatAction::RegenerateTitle,
        Some("Q4 review plan"),
        true,
    )
    .unwrap()
    .unwrap();
    assert_eq!(s.title, "Q4 review plan");
    assert_eq!(s.title_source, TitleSource::Auto);
    assert!(
        s.path.ends_with("-q4-review-plan-5328964b.md"),
        "{}",
        s.path
    );
    let (_, text) = load(&root, ID).unwrap();
    assert_eq!(text.matches("writer-chat-title-auto: true").count(), 1);
    assert!(!text.contains("writer-chat-renamed"), "{text}");
    // a stale pane that still holds the user's flags cannot bring the old title back
    let stale = save(&root, ID, &note(ID, None, "Mine", 9), None).unwrap();
    assert_eq!(stale.title, "Q4 review plan");
    assert_eq!(stale.title_source, TitleSource::Auto);
    // regenerating again replaces an automatic title too (AutoTitle would not)
    let again = action(&root, ID, ChatAction::RegenerateTitle, Some("Fresh"), true)
        .unwrap()
        .unwrap();
    assert_eq!(again.title, "Fresh");
    // a manual rename wins afterwards
    let r = action(&root, ID, ChatAction::Rename, Some("Human"), true)
        .unwrap()
        .unwrap();
    assert_eq!(
        (r.title.as_str(), r.title_source),
        ("Human", TitleSource::User)
    );
}

#[test]
fn regenerate_rejects_an_empty_title_and_keeps_the_user_title() {
    let (_d, root) = vault();
    save(&root, ID, &note(ID, None, "Draft", 1), None).unwrap();
    action(&root, ID, ChatAction::Rename, Some("Mine"), true).unwrap();
    assert!(action(&root, ID, ChatAction::RegenerateTitle, Some(" "), true).is_err());
    let s = all(&root).pop().unwrap();
    assert_eq!(
        (s.title.as_str(), s.title_source),
        ("Mine", TitleSource::User)
    );
}
