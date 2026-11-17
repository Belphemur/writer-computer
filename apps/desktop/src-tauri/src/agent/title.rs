//! Automatic chat titles (spec "Automatic chat titles"): ONE small separate `claude -p` call that
//! turns the first messages of a chat into a 3 to 6 word title. Tauri-free.
//!
//! - [`cheapest_model`] is the one place that decides which model writes titles (the `haiku`
//!   alias unless the user set `agent.title-model`); [`model_candidates`] adds the chat's own
//!   model as the fallback when the cheap one is refused or unavailable.
//! - [`build_prompt`] is the one place that decides what text leaves the app: the first two user
//!   messages and the first assistant reply, each cut to [`MAX_SNIPPET_CHARS`]. Never tool
//!   output, never file contents, never context attachments.
//! - [`sanitize_title`] turns the model's reply into a title or rejects it.
//! - [`suggest`] runs the call (spawn, stdin prompt, timeout) and never fails loudly: every
//!   failure is `None` and one debug line without any text.
//!
//! - [`messages_from_note`] and [`title_chat`] are the ONE way a title input is built and applied:
//!   the chat note is read from disk (`chat_store::load`), so the automatic call (pane, after a
//!   flush) and "Regenerate title" (history, any chat, open or not) share it; neither needs a live
//!   session beyond the consent the caller checked.
//!
//! Applying the title is `chat_store::ChatAction::AutoTitle`, which refuses to touch a title the
//! user chose, or `ChatAction::RegenerateTitle`, which the user asked for and overwrites it.

use super::binary::run_capture_in;
use super::chat_store::{self, ChatAction, ChatStoreError, Role};
use super::claude_stream::{build_title_args, is_safe_value};
use super::events::ChatSummary;
use serde::Deserialize;
use serde_json::Value;
use std::path::Path;
use std::time::Duration;

/// The CLI alias of the cheapest model family (see `model-catalog.ts`).
pub const CHEAP_MODEL_ALIAS: &str = "haiku";
/// Longest accepted title, in characters.
pub const MAX_TITLE_CHARS: usize = 60;
/// A reply with more words than this is a sentence, not a title.
const MAX_TITLE_WORDS: usize = 10;
/// Each message of the prompt is cut to this many characters.
pub const MAX_SNIPPET_CHARS: usize = 300;
const MAX_USER_MESSAGES: usize = 2;
const MAX_ASSISTANT_MESSAGES: usize = 1;
const TITLE_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_OUTPUT_BYTES: u64 = 64 * 1024;

const SYSTEM_PROMPT: &str =
    "You write short titles for chat conversations. Reply with the title only.";
const INSTRUCTION: &str = "Reply with a 3 to 6 word title for the conversation above, no quotes, no punctuation, same language as the conversation. Output only the title.";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TitleRole {
    User,
    Assistant,
}

/// One message of the chat as the pane has it: plain text only.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct TitleMessage {
    pub role: TitleRole,
    pub text: String,
}

impl From<Role> for TitleRole {
    fn from(r: Role) -> Self {
        match r {
            Role::User => TitleRole::User,
            Role::Assistant => TitleRole::Assistant,
        }
    }
}

/// The title input of a chat note: the text of every non-empty message (never tool trails or
/// context lines); [`build_prompt`] cuts it down.
pub fn messages_from_note(markdown: &str) -> Vec<TitleMessage> {
    chat_store::turns_of(markdown)
        .into_iter()
        .filter(|t| !t.text.trim().is_empty())
        .map(|t| TitleMessage {
            role: t.role.into(),
            text: t.text,
        })
        .collect()
}

/// Why a title could not be written for a chat note.
#[derive(Debug)]
pub enum TitleError {
    /// The chat has no assistant reply (or no user text) yet: nothing to title.
    NoReply,
    /// The call failed or answered junk.
    Failed,
    Store(ChatStoreError),
}

/// Read the chat note, ask for a title and apply it with `action` (`AutoTitle` or
/// `RegenerateTitle`). `chat_model` is the fallback model; `None` uses the note's own. `program`
/// and `cwd` come from a consent the caller already checked.
pub fn title_chat(
    root: &Path,
    chat_id: &str,
    program: &Path,
    cwd: &Path,
    setting: Option<&str>,
    chat_model: Option<&str>,
    action: ChatAction,
) -> Result<ChatSummary, TitleError> {
    let (_, markdown) = chat_store::load(root, chat_id).map_err(TitleError::Store)?;
    let messages = messages_from_note(&markdown);
    if !messages.iter().any(|m| m.role == TitleRole::Assistant) {
        return Err(TitleError::NoReply);
    }
    let note_model = chat_store::meta_from_text(&markdown)
        .ok()
        .flatten()
        .and_then(|m| m.model);
    let chat_model = chat_model.map(str::to_string).or(note_model);
    let text = suggest(program, cwd, setting, chat_model.as_deref(), &messages)
        .ok_or(TitleError::Failed)?;
    match chat_store::action(root, chat_id, action, Some(&text), false) {
        Ok(Some(summary)) => Ok(summary),
        Ok(None) => Err(TitleError::Failed),
        Err(e) => Err(TitleError::Store(e)),
    }
}

/// The model that writes titles: the user's `agent.title-model` when it is a safe value, else
/// the cheapest family alias.
pub fn cheapest_model(setting: Option<&str>) -> String {
    setting
        .map(str::trim)
        .filter(|m| !m.is_empty() && !m.eq_ignore_ascii_case("auto") && is_safe_value(m))
        .unwrap_or(CHEAP_MODEL_ALIAS)
        .to_string()
}

/// Models to try in order: the cheapest, then the chat's own model (`None` entry = the CLI's
/// default) when it differs.
pub fn model_candidates(setting: Option<&str>, chat_model: Option<&str>) -> Vec<Option<String>> {
    let cheap = cheapest_model(setting);
    let chat = chat_model.map(str::trim).filter(|m| !m.is_empty());
    let mut out = vec![Some(cheap.clone())];
    if chat != Some(cheap.as_str()) {
        out.push(chat.map(str::to_string));
    }
    out
}

fn snippet(text: &str) -> String {
    let one = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if one.chars().count() <= MAX_SNIPPET_CHARS {
        return one;
    }
    let cut: String = one.chars().take(MAX_SNIPPET_CHARS).collect();
    format!("{}…", cut.trim_end())
}

/// The stdin of the call, `None` when there is nothing to title (no user text).
pub fn build_prompt(messages: &[TitleMessage]) -> Option<String> {
    let (mut users, mut assistants) = (0, 0);
    let mut lines = Vec::new();
    for m in messages {
        let (count, max, label) = match m.role {
            TitleRole::User => (&mut users, MAX_USER_MESSAGES, "User"),
            TitleRole::Assistant => (&mut assistants, MAX_ASSISTANT_MESSAGES, "Assistant"),
        };
        let text = snippet(&m.text);
        if *count >= max || text.is_empty() {
            continue;
        }
        *count += 1;
        lines.push(format!("{label}: {text}"));
    }
    if users == 0 {
        return None;
    }
    Some(format!(
        "Conversation:\n{}\n\n{INSTRUCTION}",
        lines.join("\n")
    ))
}

const QUOTES: &[char] = &['"', '\'', '`', '“', '”', '‘', '’', '«', '»'];
const TRAILING: &[char] = &['.', ',', ';', ':', '!', '?', '…', '。'];

/// Strip markdown, quotes, a "Title:" label and trailing punctuation; collapse whitespace; cap at
/// [`MAX_TITLE_CHARS`] on a word boundary. `None` for an empty reply, several lines (the model
/// explained itself) or a sentence-length reply.
pub fn sanitize_title(raw: &str) -> Option<String> {
    let mut lines = raw.lines().map(str::trim).filter(|l| !l.is_empty());
    let line = lines.next()?;
    if lines.next().is_some() {
        return None;
    }
    let mut t: String = line
        .chars()
        .filter(|c| !matches!(c, '*' | '_' | '`' | '#' | '\u{200B}'))
        .collect();
    t = t.trim().to_string();
    if t.get(..6).is_some_and(|p| p.eq_ignore_ascii_case("title:")) {
        t = t[6..].trim().to_string();
    }
    let t = t
        .trim_matches(|c: char| QUOTES.contains(&c) || c.is_whitespace())
        .trim_end_matches(|c: char| TRAILING.contains(&c) || c.is_whitespace());
    let t = t.trim_matches(|c: char| QUOTES.contains(&c) || c.is_whitespace());
    let words: Vec<&str> = t.split_whitespace().collect();
    if words.is_empty() || words.len() > MAX_TITLE_WORDS {
        return None;
    }
    let mut out = String::new();
    for w in words {
        let extra = usize::from(!out.is_empty()) + w.chars().count();
        if out.chars().count() + extra > MAX_TITLE_CHARS {
            break;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(w);
    }
    // a single over-long word: cut it
    if out.is_empty() {
        out = t.chars().take(MAX_TITLE_CHARS).collect();
    }
    (!out.is_empty()).then_some(out)
}

/// The title in the CLI's `--output-format json` reply; `None` for an error result.
pub fn parse_output(stdout: &str) -> Option<String> {
    let v: Value = serde_json::from_str(stdout.trim()).ok()?;
    if v.get("is_error").and_then(Value::as_bool).unwrap_or(false) {
        return None;
    }
    sanitize_title(v.get("result")?.as_str()?)
}

/// Ask `program` (in `cwd`, a chat's own directory) for a title. Blocking up to the 30 s timeout:
/// blocking thread only. `None` on any failure; nothing about the text is logged.
pub fn suggest(
    program: &Path,
    cwd: &Path,
    setting: Option<&str>,
    chat_model: Option<&str>,
    messages: &[TitleMessage],
) -> Option<String> {
    let prompt = build_prompt(messages)?;
    for model in model_candidates(setting, chat_model) {
        let Ok(args) = build_title_args(model.as_deref(), SYSTEM_PROMPT) else {
            continue;
        };
        let started = std::time::Instant::now();
        let reply = run_capture_in(
            program,
            &args,
            cwd,
            Some(&prompt),
            TITLE_TIMEOUT,
            MAX_OUTPUT_BYTES,
        );
        let title = match reply {
            Some((true, out)) => parse_output(&out),
            _ => None,
        };
        log::debug!(
            target: "agent",
            "agent: title call finished (model: {}, ok: {}, {} ms)",
            if model.is_some() { "named" } else { "cli default" },
            title.is_some(),
            started.elapsed().as_millis()
        );
        if title.is_some() {
            return title;
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(role: TitleRole, text: &str) -> TitleMessage {
        TitleMessage {
            role,
            text: text.into(),
        }
    }

    #[test]
    fn cheapest_model_prefers_the_haiku_alias_and_validates_the_override() {
        assert_eq!(cheapest_model(None), "haiku");
        assert_eq!(cheapest_model(Some("")), "haiku");
        assert_eq!(cheapest_model(Some(" auto ")), "haiku");
        assert_eq!(cheapest_model(Some("claude-haiku-4-5")), "claude-haiku-4-5");
        assert_eq!(cheapest_model(Some("--dangerous")), "haiku");
    }

    #[test]
    fn candidates_fall_back_to_the_chat_model_once() {
        assert_eq!(
            model_candidates(None, Some("sonnet")),
            vec![Some("haiku".to_string()), Some("sonnet".to_string())]
        );
        assert_eq!(
            model_candidates(None, None),
            vec![Some("haiku".to_string()), None]
        );
        assert_eq!(
            model_candidates(None, Some("haiku")),
            vec![Some("haiku".to_string())]
        );
    }

    #[test]
    fn prompt_keeps_two_user_messages_and_one_assistant_reply_cut_short() {
        let long = "x".repeat(900);
        let p = build_prompt(&[
            msg(TitleRole::User, &long),
            msg(TitleRole::Assistant, "first reply"),
            msg(TitleRole::Assistant, "second reply"),
            msg(TitleRole::User, "second\n question"),
            msg(TitleRole::User, "third question"),
        ])
        .unwrap();
        assert!(p.contains("Assistant: first reply"));
        assert!(!p.contains("second reply"));
        assert!(p.contains("User: second question"));
        assert!(!p.contains("third"));
        assert!(p.contains(&format!("User: {}…", "x".repeat(MAX_SNIPPET_CHARS))));
        assert!(!p.contains(&"x".repeat(MAX_SNIPPET_CHARS + 1)));
        assert!(p.ends_with("Output only the title."));
        assert!(p.contains("3 to 6 word title"));
        assert!(build_prompt(&[msg(TitleRole::Assistant, "hi")]).is_none());
        assert!(build_prompt(&[msg(TitleRole::User, "  ")]).is_none());
    }

    #[test]
    fn sanitizer_strips_decoration_and_rejects_junk() {
        assert_eq!(
            sanitize_title("  \"Planning the Q4 review.\"  ").as_deref(),
            Some("Planning the Q4 review")
        );
        assert_eq!(
            sanitize_title("**Title:** `Team  offsite\tbudget`").as_deref(),
            Some("Team offsite budget")
        );
        assert_eq!(
            sanitize_title("# “Résumé du projet”").as_deref(),
            Some("Résumé du projet")
        );
        assert_eq!(sanitize_title(""), None);
        assert_eq!(sanitize_title("  \n "), None);
        assert_eq!(sanitize_title("\"\""), None);
        assert_eq!(sanitize_title("Budget plan\nHere is why I chose it"), None);
        assert_eq!(
            sanitize_title("I am sorry but I cannot help with that request at all today ok"),
            None
        );
        let long = "alpha ".repeat(9);
        let t = sanitize_title(&long).unwrap();
        assert!(t.chars().count() <= MAX_TITLE_CHARS);
        assert!(!t.ends_with(' '));
        let word = "a".repeat(200);
        assert_eq!(
            sanitize_title(&word).unwrap().chars().count(),
            MAX_TITLE_CHARS
        );
    }

    #[test]
    fn note_messages_are_text_only() {
        let note = std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../tests/fixtures/agent-chat-notes/basic.md"),
        )
        .unwrap();
        let m = messages_from_note(&note);
        assert_eq!(m.len(), 2);
        assert_eq!(m[0].role, TitleRole::User);
        assert_eq!(m[0].text, "Summarise the notes tagged #client.");
        assert_eq!(m[1].role, TitleRole::Assistant);
        assert!(m[1].text.starts_with("Here is the summary."));
        assert!(!m[1].text.contains("writer:tools") && !m[1].text.contains("ls -la"));
        assert!(!m[0].text.contains("context:"));
        assert!(messages_from_note("no frontmatter, no sections").is_empty());
    }

    #[test]
    fn output_parser_reads_the_json_result_and_refuses_errors() {
        assert_eq!(
            parse_output(
                r#"{"is_error":false,"result":"Planning Q4 Team Review","total_cost_usd":0.0002}"#
            )
            .as_deref(),
            Some("Planning Q4 Team Review")
        );
        assert_eq!(
            parse_output(r#"{"is_error":true,"result":"API Error"}"#),
            None
        );
        assert_eq!(parse_output("not json"), None);
        assert_eq!(parse_output(r#"{"result":7}"#), None);
    }
}

#[cfg(all(test, unix))]
mod fake_claude_tests {
    //! The title call against a FAKE `claude` (a bash script): it records its argv and stdin and
    //! answers by mode. The real CLI is never started here.
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;

    const FAKE: &str = r##"#!/bin/bash
D="$(cd "$(dirname "$0")" && pwd)"
echo "$@" >> "$D/argv.log"
printf '%s' "$(cat)" > "$D/stdin.log"
pwd >> "$D/cwd.log"
case " $* " in
  *" --model haiku "*) MODEL=haiku;;
  *" --model sonnet "*) MODEL=sonnet;;
  *) MODEL=default;;
esac
MODE="$(cat "$D/mode.txt" 2>/dev/null || echo ok)"
case "$MODE" in
  ok) printf '{"is_error":false,"result":"\\"Planning the Q4 review.\\"","total_cost_usd":0.0002}\n';;
  haiku-refused) if [ "$MODEL" = haiku ]; then echo "model unavailable" >&2; exit 1; fi
    printf '{"is_error":false,"result":"Fallback title","total_cost_usd":0.001}\n';;
  junk) printf '{"is_error":false,"result":"Here you go\\nPlanning"}\n';;
  error-result) printf '{"is_error":true,"result":"API Error: 500"}\n'; exit 1;;
  hang) sleep 300;;
  *) exit 2;;
esac
"##;

    struct Fake {
        dir: tempfile::TempDir,
        program: PathBuf,
    }

    fn fake(mode: &str) -> Fake {
        std::env::set_var("SHELL", "/bin/sh");
        let dir = tempfile::tempdir().unwrap();
        let program = dir.path().join("claude");
        std::fs::write(&program, FAKE).unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(dir.path().join("mode.txt"), mode).unwrap();
        Fake { dir, program }
    }

    fn log(f: &Fake, name: &str) -> String {
        std::fs::read_to_string(f.dir.path().join(name)).unwrap_or_default()
    }

    fn convo() -> Vec<TitleMessage> {
        vec![
            TitleMessage {
                role: TitleRole::User,
                text: "Help me plan the Q4 review".into(),
            },
            TitleMessage {
                role: TitleRole::Assistant,
                text: "Start with the goals.".into(),
            },
        ]
    }

    fn run(f: &Fake, chat_model: Option<&str>) -> Option<String> {
        let cwd = tempfile::tempdir().unwrap();
        suggest(&f.program, cwd.path(), None, chat_model, &convo())
    }

    #[test]
    fn asks_haiku_once_with_the_fixed_flags_and_the_prompt_on_stdin() {
        let f = fake("ok");
        assert_eq!(
            run(&f, Some("sonnet")).as_deref(),
            Some("Planning the Q4 review")
        );
        let argv = log(&f, "argv.log");
        assert_eq!(
            argv.lines().count(),
            1,
            "one call when the cheap model answers"
        );
        for flag in [
            "-p",
            "--output-format json",
            "--max-turns 1",
            "--no-session-persistence",
            "--setting-sources",
            "--disable-slash-commands",
            "--strict-mcp-config",
            "--model haiku",
            "--system-prompt",
        ] {
            assert!(argv.contains(flag), "{flag} in {argv}");
        }
        assert!(!argv.contains("Help me plan"), "message text never in argv");
        assert!(!argv.contains("stream-json") && !argv.contains("--resume"));
        let stdin = log(&f, "stdin.log");
        assert!(stdin.contains("User: Help me plan the Q4 review"));
        assert!(stdin.contains("Assistant: Start with the goals."));
    }

    #[test]
    fn a_refused_cheap_model_falls_back_to_the_chat_model() {
        let f = fake("haiku-refused");
        assert_eq!(run(&f, Some("sonnet")).as_deref(), Some("Fallback title"));
        let argv = log(&f, "argv.log");
        assert_eq!(argv.lines().count(), 2);
        assert!(argv.lines().nth(1).unwrap().contains("--model sonnet"));
    }

    #[test]
    fn failures_are_quiet_and_junk_is_refused() {
        for mode in ["junk", "error-result", "crash"] {
            let f = fake(mode);
            assert_eq!(run(&f, None), None, "{mode}");
        }
        // no user text: nothing is spawned
        let f = fake("ok");
        let cwd = tempfile::tempdir().unwrap();
        assert_eq!(suggest(&f.program, cwd.path(), None, None, &[]), None);
        assert_eq!(log(&f, "argv.log"), "");
        // a missing program
        assert_eq!(
            suggest(&f.dir.path().join("nope"), cwd.path(), None, None, &convo()),
            None
        );
    }

    #[test]
    fn runs_in_the_chats_directory() {
        let f = fake("ok");
        let cwd = tempfile::tempdir().unwrap();
        let canon = cwd.path().canonicalize().unwrap();
        suggest(&f.program, &canon, None, None, &convo()).unwrap();
        assert_eq!(log(&f, "cwd.log").trim(), canon.to_string_lossy());
    }

    // ---- title_chat: the note on disk is the input, no live session

    use crate::agent::chat_store::{self, ChatAction};
    use crate::agent::events::TitleSource;

    const CHAT: &str = "5328964b-5fe4-4e06-8843-5cf92bdc9e7c";

    fn basic_note() -> String {
        std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../tests/fixtures/agent-chat-notes/basic.md"),
        )
        .unwrap()
    }

    /// A vault holding the golden chat note (user message and an assistant reply).
    fn vault_with(note: &str) -> (tempfile::TempDir, PathBuf) {
        let d = tempfile::tempdir().unwrap();
        let root = d.path().canonicalize().unwrap();
        std::fs::create_dir_all(root.join("Projects/Demo")).unwrap();
        chat_store::save(&root, CHAT, note, None).unwrap();
        (d, root)
    }

    fn regenerate(f: &Fake, root: &Path) -> Result<ChatSummary, TitleError> {
        title_chat(
            root,
            CHAT,
            &f.program,
            root,
            None,
            None,
            ChatAction::RegenerateTitle,
        )
    }

    fn title_of(root: &Path) -> (String, TitleSource) {
        let (s, _) = chat_store::load(root, CHAT).unwrap();
        (s.title, s.title_source)
    }

    #[test]
    fn regenerates_a_closed_chats_title_from_its_note_and_overwrites_a_user_title() {
        let f = fake("ok");
        let (_d, root) = vault_with(&basic_note());
        chat_store::action(&root, CHAT, ChatAction::Rename, Some("Mine"), true).unwrap();
        let s = regenerate(&f, &root).unwrap();
        assert_eq!(s.title, "Planning the Q4 review");
        assert_eq!(s.title_source, TitleSource::Auto);
        assert_eq!(title_of(&root).1, TitleSource::Auto);
        let (_, text) = chat_store::load(&root, CHAT).unwrap();
        assert!(text.contains("writer-chat-title-auto: true"));
        assert!(!text.contains("writer-chat-renamed"));
        // the input is the note's text, the chat's own model is the (unused) fallback
        let stdin = log(&f, "stdin.log");
        assert!(stdin.contains("User: Summarise the notes tagged #client."));
        assert!(stdin.contains("Assistant: Here is the summary."));
        assert!(!stdin.contains("context:") && !stdin.contains("ls -la"));
        assert_eq!(log(&f, "argv.log").lines().count(), 1);
    }

    #[test]
    fn a_failed_call_keeps_the_title() {
        let f = fake("junk");
        let (_d, root) = vault_with(&basic_note());
        chat_store::action(&root, CHAT, ChatAction::Rename, Some("Mine"), true).unwrap();
        assert!(matches!(regenerate(&f, &root), Err(TitleError::Failed)));
        assert_eq!(title_of(&root), ("Mine".into(), TitleSource::User));
    }

    #[test]
    fn a_chat_without_a_reply_is_refused_before_anything_runs() {
        let f = fake("ok");
        let note = basic_note();
        let user_only = &note[..note.find("## assistant").unwrap()];
        let (_d, root) = vault_with(user_only);
        assert!(matches!(regenerate(&f, &root), Err(TitleError::NoReply)));
        assert_eq!(log(&f, "argv.log"), "", "no process for an empty chat");
        assert_eq!(title_of(&root).0, "Plan the Q4 review");
        // an unknown chat is a store error, not a call
        let r = title_chat(
            &root,
            "aaaaaaaa-0000-4000-8000-000000000009",
            &f.program,
            &root,
            None,
            None,
            ChatAction::RegenerateTitle,
        );
        assert!(matches!(r, Err(TitleError::Store(_))));
        assert_eq!(log(&f, "argv.log"), "");
    }
}
