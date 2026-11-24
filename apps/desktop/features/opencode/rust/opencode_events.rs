//! The mapper: one OpenCode event in, the neutral [`Mapped`] out (spec
//! `SPECs/opencode-backend-spec.md` section 6). Pure: no I/O, no clock (a turn's duration is the
//! difference of the events' own `created`), no knowledge of tool names beyond the one codemode
//! tool. Its twin is `claude_stream.rs`; both feed the same `AgentEvent`s, and `Session` and
//! `sub_tracker` stay the only producers of `Subagent*` status and the `SubagentStarted` event.
//!
//! What [`MapState`] holds is only what an event does not carry: the models of the messages, the
//! last input of each tool call (for the permission card), the open forms, the codemode rows
//! already shown, the sub-agent links and the usage of the turn so far.
//!
//! **Sub-agents.** `session.created{parentID}` registers a child session; its events are held
//! until the parent's `session.tool.progress {metadata.sessionID}` names the launch call (the only
//! link, A10: no heuristic), then flow with that call as `parent_tool_call_id`. A child still
//! unlinked when its parent's execution ends is a protocol error. The mapper emits the neutral
//! [`TaskSignal`] (`Started`, `Notified`) for the tracker, and `SubagentMessage` / `SubagentModel`
//! itself, as the Claude mapper does for its stream.
//!
//! **Codemode** (`execute`, Writer's configuration): the model calls one tool with JavaScript and
//! the real calls are the rows of `metadata.toolCalls`. Each shows as a row of its own
//! (`<execute id>:<n>`, tool `<server>_<tool>`), nested under the `execute` row, finished when its
//! status leaves `running`; the final `metadata` of the `execute` call settles any row the
//! progress events did not show.

use super::opencode_api::*;
use crate::agent::events::*;
use crate::agent::sub_tracker::subagent_step;
use crate::agent::transport::Mapped;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

/// An inner call of a codemode `execute` call.
struct Row {
    id: String,
    tool: String,
    finished: bool,
    /// A permission card was attached to it already.
    asked: bool,
}

/// A sub-agent session of this chat.
#[derive(Default)]
struct Child {
    /// The session that launched it.
    parent: String,
    /// The launch call, once `tool.progress` named it.
    link: Option<String>,
    /// Events that arrived before the link.
    held: Vec<WireEvent>,
    /// The model last reported by `SubagentModel`.
    reported_model: Option<String>,
    /// The final state was told to the tracker (and whether with a report).
    notified: Option<(SubagentRunStatus, bool)>,
    /// The protocol error for a missing link was sent.
    errored: bool,
}

struct PendingForm {
    session: String,
    tool_call_id: String,
    /// (question text, key, multi-select) per field, in order, to rebuild the answers.
    fields: Vec<(String, String, bool)>,
}

/// Tokens and cost summed over the steps of one execution.
#[derive(Default)]
struct TurnSum {
    started: f64,
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
    cost: Option<f64>,
    model: Option<String>,
}

impl TurnSum {
    fn add(&mut self, t: &Tokens, cost: Option<f64>) {
        self.input += t.input;
        self.output += t.output + t.reasoning;
        self.cache_read += t.cache.read;
        self.cache_write += t.cache.write;
        if let Some(c) = cost {
            *self.cost.get_or_insert(0.0) += c;
        }
    }
}

/// What an event of the transcript already showed, so a resync from the message list adds only
/// what is missing.
#[derive(Default)]
struct Shown {
    texts: HashSet<(String, u32)>,
    thinking: HashSet<(String, u32)>,
    tools: HashSet<String>,
    /// Tool calls whose end was shown (by an event or by a resync).
    finished: HashSet<String>,
}

pub struct MapState {
    main: String,
    children: HashMap<String, Child>,
    models: HashMap<String, ModelRef>,
    limits: HashMap<String, u64>,
    inputs: HashMap<String, Value>,
    /// Tool call id -> (tool name, assistant message id).
    calls: HashMap<String, (String, String)>,
    rows: HashMap<String, Vec<Row>>,
    forms: HashMap<String, PendingForm>,
    /// Request id -> the session it was asked in (a sub-agent's request is answered there).
    permissions: HashMap<String, String>,
    turn: TurnSum,
    /// An execution started and its end was not shown yet.
    turn_open: bool,
    /// The name of the codemode tool (the table's row of that role): its calls are rows of their own.
    codemode: Option<String>,
    /// Final text of a sub-agent report by child session, from the synthetic inbox item.
    reports: HashMap<String, String>,
    shown: Shown,
}

impl MapState {
    pub fn new(main: &str) -> Self {
        Self {
            main: main.to_string(),
            children: HashMap::new(),
            models: HashMap::new(),
            limits: HashMap::new(),
            inputs: HashMap::new(),
            calls: HashMap::new(),
            rows: HashMap::new(),
            forms: HashMap::new(),
            permissions: HashMap::new(),
            turn: TurnSum::default(),
            turn_open: false,
            codemode: None,
            reports: HashMap::new(),
            shown: Shown::default(),
        }
    }

    /// Names the codemode tool (`Role::Codemode` of the tool table).
    #[cfg(test)]
    pub fn with_codemode(mut self, tool: Option<&str>) -> Self {
        self.codemode = tool.map(String::from);
        self
    }

    /// The context window of each model (`provider/model` -> tokens), for the usage ring.
    pub fn set_limits(&mut self, limits: HashMap<String, u64>) {
        self.limits = limits;
    }

    /// The session a pending permission request was asked in.
    pub fn permission_session(&self, request_id: &str) -> Option<&str> {
        self.permissions.get(request_id).map(String::as_str)
    }

    /// The session a pending form was asked in.
    pub fn form_session(&self, form_id: &str) -> Option<&str> {
        self.forms.get(form_id).map(|f| f.session.as_str())
    }

    /// The reply of a pending form for the user's answers, and the session it is posted in. One
    /// entry per field, matched by the question text, else by position; a single-select field is
    /// answered with its label, a multi-select with the list. `None` when the form is unknown.
    pub fn answer_body(
        &self,
        form_id: &str,
        answers: &[QuestionAnswer],
    ) -> Option<(String, Value)> {
        let form = self.forms.get(form_id)?;
        let mut body = serde_json::Map::new();
        for (i, (question, key, multi)) in form.fields.iter().enumerate() {
            let given = answers
                .iter()
                .find(|a| &a.question == question)
                .or_else(|| answers.get(i));
            let values: Vec<String> = given.map(|a| a.answers.clone()).unwrap_or_default();
            let value = if *multi {
                json!(values)
            } else {
                json!(values.into_iter().next().unwrap_or_default())
            };
            body.insert(key.clone(), value);
        }
        Some((form.session.clone(), Value::Object(body)))
    }

    /// The sessions of this chat that are sub-agents (linked or not).
    pub fn children(&self) -> impl Iterator<Item = &str> {
        self.children.keys().map(String::as_str)
    }

    /// Maps one event of the chat's session or of one of its sub-agents.
    pub fn map(&mut self, ev: &WireEvent) -> Mapped {
        let mut out = Mapped::default();
        let event = match Event::parse(ev) {
            Ok(e) => e,
            Err(_) => {
                out.events.push(protocol(format!(
                    "OpenCode sent an event Writer could not read ({})",
                    ev.kind
                )));
                return out;
            }
        };
        if let Event::SessionCreated(c) = &event {
            self.on_created(c);
            return out;
        }
        let Some(session) = owner(&event) else {
            return out;
        };
        if session == self.main {
            self.on_event(&session, None, event, ev.created, &mut out);
        } else if let Some(child) = self.children.get_mut(&session) {
            match child.link.clone() {
                Some(call) => self.on_event(&session, Some(&call), event, ev.created, &mut out),
                None => child.held.push(ev.clone()),
            }
        }
        out
    }

    fn on_created(&mut self, c: &SessionCreated) {
        let Some(parent) = c.parentID.as_deref() else {
            return;
        };
        // the server routes only the sessions of this chat (ancestry is its job, `server.rs`)
        self.children.insert(
            c.sessionID.clone(),
            Child {
                parent: parent.to_string(),
                ..Child::default()
            },
        );
    }

    /// The session's own events. `call` is the launch call when it is a sub-agent's.
    fn on_event(
        &mut self,
        session: &str,
        call: Option<&str>,
        event: Event,
        created: f64,
        out: &mut Mapped,
    ) {
        let main = call.is_none();
        let parent = call.map(String::from);
        match event {
            Event::ExecutionStarted(_) if main => {
                self.turn_open = true;
                self.turn = TurnSum {
                    started: created,
                    ..TurnSum::default()
                };
            }
            Event::StepStarted(s) => {
                let slug = s.model.as_ref().map(ModelRef::slug);
                if let Some(m) = s.model {
                    self.models.insert(s.assistantMessageID.clone(), m);
                }
                if main {
                    self.turn.model = slug;
                } else if let Some(call) = &parent {
                    // a sub-agent's step: its message and, when it changed, its model
                    let child = self.children.get_mut(session);
                    let mut last = child.as_ref().and_then(|c| c.reported_model.clone());
                    out.events.extend(subagent_step(
                        &s.assistantMessageID,
                        call,
                        slug.as_deref(),
                        &mut last,
                    ));
                    if let Some(c) = child {
                        c.reported_model = last;
                    }
                }
            }
            Event::TextDelta(d) => out.events.push(AgentEvent::TextDelta {
                message_id: d.assistantMessageID,
                block_index: d.ordinal,
                text: d.delta,
            }),
            Event::TextEnded(t) => {
                // a resync may have shown this block already
                if !self
                    .shown
                    .texts
                    .insert((t.assistantMessageID.clone(), t.ordinal))
                {
                    return;
                }
                out.events.push(AgentEvent::Text {
                    message_id: t.assistantMessageID,
                    block_index: t.ordinal,
                    text: t.text,
                });
            }
            Event::ReasoningStarted(r) => out.events.push(thinking(
                r.assistantMessageID,
                r.ordinal,
                ThinkingPhase::Start,
                String::new(),
            )),
            Event::ReasoningDelta(r) => out.events.push(thinking(
                r.assistantMessageID,
                r.ordinal,
                ThinkingPhase::Delta,
                r.delta,
            )),
            Event::ReasoningEnded(r) => {
                self.shown
                    .thinking
                    .insert((r.assistantMessageID.clone(), r.ordinal));
                out.events.push(thinking(
                    r.assistantMessageID,
                    r.ordinal,
                    ThinkingPhase::End,
                    r.text,
                ));
            }
            Event::ToolInputStarted(t) => {
                self.calls
                    .insert(t.id.clone(), (t.name.clone(), t.assistantMessageID.clone()));
                if !self.shown.tools.insert(t.id.clone()) {
                    return;
                }
                out.events.push(AgentEvent::ToolCallStarted {
                    tool_call_id: t.id,
                    message_id: t.assistantMessageID,
                    tool: t.name,
                    parent_tool_call_id: parent,
                });
            }
            Event::ToolInputDelta(t) => out.events.push(AgentEvent::ToolCallInputDelta {
                tool_call_id: t.id,
                partial_json: t.delta,
            }),
            Event::ToolCalled(t) => {
                self.inputs.insert(t.id.clone(), t.input.clone());
                out.events.push(AgentEvent::ToolCallInput {
                    tool_call_id: t.id,
                    input: t.input,
                });
            }
            Event::ToolProgress(p) => self.on_progress(session, p, out),
            Event::ToolSuccess(t) => {
                if self.shown.finished.contains(&t.id) {
                    return;
                }
                self.settle_rows(&t.id, &t.metadata, false, out);
                let truncated = t.metadata.get("truncated").and_then(Value::as_bool) == Some(true);
                self.finished(t.id, text_of(&t.content), None, truncated, out);
            }
            Event::ToolFailed(t) => {
                if self.shown.finished.contains(&t.id) {
                    return;
                }
                self.settle_rows(&t.id, &Value::Null, true, out);
                self.finished(t.id, t.error.message, Some(&t.error.kind), false, out);
            }
            Event::PermissionAsked(p) => self.on_permission(session, p, out),
            Event::PermissionReplied(p) => {
                self.permissions.remove(&p.requestID);
                out.events.push(AgentEvent::PermissionResolved {
                    request_id: p.requestID,
                    resolution: if p.reply == "reject" {
                        PermissionResolution::Denied
                    } else {
                        PermissionResolution::Allowed
                    },
                });
            }
            Event::FormCreated(f) => self.on_form(f.form, out),
            Event::FormReplied(f) => {
                if let Some(pending) = self.forms.remove(&f.id) {
                    let answers = pending
                        .fields
                        .iter()
                        .filter_map(|(question, key, _)| {
                            let values = match f.answer.get(key)? {
                                Value::String(s) => vec![s.clone()],
                                Value::Array(a) => a
                                    .iter()
                                    .filter_map(|v| v.as_str().map(String::from))
                                    .collect(),
                                _ => return None,
                            };
                            Some(QuestionAnswer {
                                question: question.clone(),
                                answers: values,
                            })
                        })
                        .collect();
                    out.events.push(AgentEvent::QuestionResolved {
                        request_id: f.id,
                        tool_call_id: Some(pending.tool_call_id),
                        resolution: QuestionResolution::Answered,
                        answers,
                    });
                }
            }
            Event::FormCancelled(f) => {
                if let Some(pending) = self.forms.remove(&f.id) {
                    out.events.push(AgentEvent::QuestionResolved {
                        request_id: f.id,
                        tool_call_id: Some(pending.tool_call_id),
                        resolution: QuestionResolution::Skipped,
                        answers: Vec::new(),
                    });
                }
            }
            Event::StepEnded(s) if main => {
                self.on_step(s.assistantMessageID, &s.tokens, s.cost, true, out)
            }
            Event::StepFailed(s) if main => {
                let counted = s.tokens != Tokens::default() || s.cost.is_some();
                self.on_step(s.assistantMessageID, &s.tokens, s.cost, counted, out);
            }
            Event::ExecutionSucceeded(_) if main => {
                self.finish_turn(created, TurnFinishReason::Completed, Vec::new(), out)
            }
            Event::ExecutionInterrupted(_) if main => {
                self.finish_turn(created, TurnFinishReason::Interrupted, Vec::new(), out)
            }
            Event::ExecutionFailed(f) if main => {
                let (kind, retryable) = error_kind(&f.error);
                out.events.push(AgentEvent::Error {
                    kind,
                    message: f.error.message.clone(),
                    retryable,
                });
                self.finish_turn(created, TurnFinishReason::Error, vec![f.error.message], out);
            }
            Event::RetryScheduled(r) => {
                let (kind, _) = error_kind(&r.error);
                out.events.push(AgentEvent::Error {
                    kind,
                    message: r.error.message,
                    retryable: true,
                });
            }
            Event::InboxEnqueued(i) => {
                if i.item.kind == "synthetic" {
                    self.on_report(&i.item, out);
                } else if let Some(receipt) = receipt_for(&i.inboxID) {
                    out.accepted = Some(receipt);
                }
            }
            Event::InboxDelivered(i) => out.taken = receipt_for(&i.inboxID),
            Event::JobUpdated(j) => self.on_job(j.info, out),
            // everything else is bookkeeping of the server (or a child's own turn)
            _ => {}
        }
    }

    // ------------------------------------------------------------------ steps and turns

    fn on_step(
        &mut self,
        message: String,
        tokens: &Tokens,
        cost: Option<f64>,
        counted: bool,
        out: &mut Mapped,
    ) {
        if !counted {
            return;
        }
        self.turn.add(tokens, cost);
        let slug = self.models.get(&message).map(ModelRef::slug);
        out.events.push(AgentEvent::Usage {
            scope: UsageScope::Message,
            input_tokens: tokens.input,
            output_tokens: tokens.output + tokens.reasoning,
            cache_read_tokens: tokens.cache.read,
            cache_creation_tokens: tokens.cache.write,
            cost_usd: cost,
            context_window: slug.as_ref().and_then(|s| self.limits.get(s)).copied(),
            model: None,
        });
    }

    fn finish_turn(
        &mut self,
        ended: f64,
        reason: TurnFinishReason,
        errors: Vec<String>,
        out: &mut Mapped,
    ) {
        self.turn_open = false;
        let turn = std::mem::take(&mut self.turn);
        let window = turn
            .model
            .as_ref()
            .and_then(|m| self.limits.get(m))
            .copied();
        out.events.push(AgentEvent::Usage {
            scope: UsageScope::Turn,
            input_tokens: turn.input,
            output_tokens: turn.output,
            cache_read_tokens: turn.cache_read,
            cache_creation_tokens: turn.cache_write,
            cost_usd: turn.cost,
            context_window: window,
            model: turn.model,
        });
        out.events.push(AgentEvent::TurnFinished {
            reason,
            duration_ms: if turn.started > 0.0 && ended >= turn.started {
                (ended - turn.started) as u64
            } else {
                0
            },
            api_duration_ms: None,
            num_turns: None,
            is_error: reason == TurnFinishReason::Error,
            result: None,
            session_id: Some(self.main.clone()),
            errors,
        });
        // a child that never got its link can no longer get one (A10): say so, once
        let unlinked: Vec<String> = self
            .children
            .iter()
            .filter(|(_, c)| c.link.is_none() && !c.errored)
            .map(|(id, _)| id.clone())
            .collect();
        for id in unlinked {
            if let Some(c) = self.children.get_mut(&id) {
                // the held events stay: a late link still releases them
                c.errored = true;
            }
            out.events.push(protocol(
                "a sub-agent session was never linked to its launch call".into(),
            ));
        }
    }

    // ------------------------------------------------------------------ tools

    /// The end of a tool call, for the live path and the resync alike: `error` is the server's
    /// error type (`aborted` and `permission.rejected` are the user's own refusals).
    fn finished(
        &mut self,
        id: String,
        output: String,
        error: Option<&str>,
        truncated: bool,
        out: &mut Mapped,
    ) {
        self.inputs.remove(&id);
        self.shown.finished.insert(id.clone());
        let rejected = matches!(error, Some("aborted" | "permission.rejected"));
        out.events.push(AgentEvent::ToolCallFinished {
            tool_call_id: id,
            output,
            is_error: error.is_some(),
            outcome: match (error.is_some(), rejected) {
                (false, _) => ToolOutcome::Ok,
                (true, true) => ToolOutcome::Rejected,
                (true, false) => ToolOutcome::Error,
            },
            truncated,
        });
    }

    fn on_progress(&mut self, session: &str, p: ToolProgress, out: &mut Mapped) {
        if let Some(child) = p.metadata.get("sessionID").and_then(Value::as_str) {
            self.link(session, child, &p.id, out);
        }
        if let Some(calls) = p.metadata.get("toolCalls").and_then(Value::as_array) {
            self.show_rows(&p.id, calls, out);
        }
    }

    /// The parent's `tool.progress` (or the launch block of a message list) named the child:
    /// release what it held. A child nobody saw created (the stream was down) is registered by
    /// this very name.
    fn link(&mut self, parent: &str, child_id: &str, call: &str, out: &mut Mapped) {
        let child = self
            .children
            .entry(child_id.to_string())
            .or_insert_with(|| Child {
                parent: parent.to_string(),
                ..Child::default()
            });
        if child.link.is_some() || child.parent != parent {
            return;
        }
        child.link = Some(call.to_string());
        let held = std::mem::take(&mut child.held);
        out.tasks.push(TaskSignal::Started {
            task: child_id.to_string(),
            call: Some(call.to_string()),
            background: true,
        });
        for ev in held {
            let more = self.map(&ev);
            out.events.extend(more.events);
            out.tasks.extend(more.tasks);
            out.taken = out.taken.take().or(more.taken);
            out.accepted = out.accepted.take().or(more.accepted);
        }
    }

    /// The rows of a codemode call's `metadata.toolCalls` that are not shown yet, finished where
    /// their status says so.
    fn show_rows(&mut self, exec: &str, calls: &[Value], out: &mut Mapped) {
        let Some((name, message)) = self.calls.get(exec).cloned() else {
            return;
        };
        if self.codemode.as_deref() != Some(name.as_str()) {
            return;
        }
        let rows = self.rows.entry(exec.to_string()).or_default();
        for (n, entry) in calls.iter().enumerate() {
            let status = entry.get("status").and_then(Value::as_str).unwrap_or("");
            if n == rows.len() {
                let tool = inner_tool_name(entry.get("tool").and_then(Value::as_str).unwrap_or(""));
                let id = format!("{exec}:{n}");
                out.events.push(AgentEvent::ToolCallStarted {
                    tool_call_id: id.clone(),
                    message_id: message.clone(),
                    tool: tool.clone(),
                    parent_tool_call_id: Some(exec.to_string()),
                });
                out.events.push(AgentEvent::ToolCallInput {
                    tool_call_id: id.clone(),
                    input: entry.get("input").cloned().unwrap_or_else(|| json!({})),
                });
                rows.push(Row {
                    id,
                    tool,
                    finished: false,
                    asked: false,
                });
            }
            let Some(row) = rows.get_mut(n) else { continue };
            if status != "running" && !status.is_empty() && !row.finished {
                row.finished = true;
                let failed = matches!(status, "error" | "failed" | "denied");
                out.events.push(AgentEvent::ToolCallFinished {
                    tool_call_id: row.id.clone(),
                    output: String::new(),
                    is_error: failed,
                    outcome: if failed {
                        ToolOutcome::Error
                    } else {
                        ToolOutcome::Ok
                    },
                    truncated: false,
                });
            }
        }
    }

    /// The `execute` call ended: show and finish every row it still owes.
    fn settle_rows(&mut self, exec: &str, metadata: &Value, failed: bool, out: &mut Mapped) {
        if let Some(calls) = metadata.get("toolCalls").and_then(Value::as_array) {
            self.show_rows(exec, calls, out);
        }
        for row in self.rows.remove(exec).into_iter().flatten() {
            if !row.finished {
                out.events.push(AgentEvent::ToolCallFinished {
                    tool_call_id: row.id,
                    output: String::new(),
                    is_error: failed,
                    outcome: if failed {
                        ToolOutcome::Error
                    } else {
                        ToolOutcome::Ok
                    },
                    truncated: false,
                });
            }
        }
    }

    // ------------------------------------------------------------------ permissions and forms

    fn on_permission(&mut self, session: &str, p: PermissionAsked, out: &mut Mapped) {
        self.permissions.insert(p.id.clone(), session.to_string());
        let source = p.source.id.as_str();
        let called = self.calls.get(source).map(|(name, _)| name.as_str());
        // an inner call of a codemode `execute`: the card is about the inner call and its own
        // arguments, not about the JavaScript
        let inner = called.is_some() && called == self.codemode.as_deref();
        let (tool, call, input) = if inner {
            let row = self
                .rows
                .get_mut(source)
                .and_then(|rows| rows.iter_mut().find(|r| !r.asked && r.tool == p.action));
            let call = row.map(|r| {
                r.asked = true;
                r.id.clone()
            });
            let input = p
                .metadata
                .get("input")
                .cloned()
                .unwrap_or_else(|| json!({}));
            (p.action.clone(), call.or(Some(source.to_string())), input)
        } else {
            let input = self
                .inputs
                .get(source)
                .cloned()
                .unwrap_or_else(|| json!({"resources": p.resources, "metadata": p.metadata}));
            let tool = called.map_or_else(|| p.action.clone(), String::from);
            (
                tool,
                (!source.is_empty()).then(|| source.to_string()),
                input,
            )
        };
        out.events.push(AgentEvent::PermissionRequest {
            request_id: p.id,
            tool_call_id: call,
            tool,
            display_name: None,
            input,
            description: None,
            decision_reason: None,
            suggestions: suggestions(&p.action, &p.save),
            by: None,
        });
    }

    fn on_form(&mut self, form: Form, out: &mut Mapped) {
        if form.metadata.kind != "question" {
            return;
        }
        let questions = form
            .fields
            .iter()
            .map(|f| Question {
                question: f.description.clone(),
                header: f.title.clone(),
                multi_select: f.kind == "multiselect",
                options: f
                    .options
                    .iter()
                    .map(|o| QuestionOption {
                        label: o.label.clone(),
                        description: o.description.clone(),
                        preview: None,
                    })
                    .collect(),
            })
            .collect();
        self.forms.insert(
            form.id.clone(),
            PendingForm {
                session: form.sessionID.clone(),
                tool_call_id: form.metadata.tool.id.clone(),
                fields: form
                    .fields
                    .iter()
                    .map(|f| {
                        (
                            f.description.clone(),
                            f.key.clone(),
                            f.kind == "multiselect",
                        )
                    })
                    .collect(),
            },
        );
        out.events.push(AgentEvent::QuestionRequest {
            request_id: form.id,
            tool_call_id: Some(form.metadata.tool.id),
            questions,
            by: None,
        });
    }

    // ------------------------------------------------------------------ sub-agent lifecycle

    /// A synthetic inbox item of the parent: the sub-agent's report.
    fn on_report(&mut self, item: &InboxItem, out: &mut Mapped) {
        let meta = &item.payload["metadata"];
        if meta.get("source").and_then(Value::as_str) != Some("subagent") {
            return;
        }
        let Some(child) = meta.get("childID").and_then(Value::as_str) else {
            return;
        };
        let text = item
            .payload
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("");
        let Some(report) = background_report(text) else {
            return;
        };
        self.reports.insert(child.to_string(), report.clone());
        // the end was told before the report: the tracker takes the report as a late addition
        if let Some(c) = self.children.get_mut(child) {
            if let (Some((status, false)), Some(call)) = (c.notified, c.link.clone()) {
                c.notified = Some((status, true));
                out.tasks.push(TaskSignal::Notified {
                    task: child.to_string(),
                    call: Some(call),
                    status,
                    report: Some(report),
                });
            }
        }
    }

    fn on_job(&mut self, job: JobInfo, out: &mut Mapped) {
        if job.kind != "subagent" {
            return;
        }
        let child = job.childSessionID.unwrap_or(job.id);
        let status = match job.status.as_str() {
            "running" => return,
            "completed" => SubagentRunStatus::Completed,
            "error" => SubagentRunStatus::Failed,
            other => SubagentRunStatus::from_cli(other),
        };
        let report = self.reports.get(&child).cloned();
        let Some(c) = self.children.get_mut(&child) else {
            return;
        };
        if c.notified.is_some() {
            return;
        }
        c.notified = Some((status, report.is_some()));
        out.tasks.push(TaskSignal::Notified {
            task: child,
            call: c.link.clone(),
            status,
            report,
        });
    }

    // ------------------------------------------------------------------ resync

    /// Reconciles the transcript with `GET /api/session/{id}/message` after the stream dropped:
    /// what the list holds and no event showed is emitted, in the order of the conversation. Text
    /// and thinking blocks replace by (message, ordinal), a tool call is shown once and finished
    /// once, and a turn the list says ended (an `idle` item) but no event ended is finished here.
    pub fn resync(&mut self, messages: &Value) -> Mapped {
        let main = self.main.clone();
        self.resync_in(&main, messages, false)
    }

    /// The list of a chat resumed in a fresh process: the history is marked as shown without
    /// being emitted (the chat note holds it), only the blocks of a turn still running are.
    pub fn seed(&mut self, messages: &Value) -> Mapped {
        let main = self.main.clone();
        self.resync_in(&main, messages, true)
    }

    /// The list of one sub-agent session (it must be linked to its launch call already).
    pub fn resync_child(&mut self, child: &str, messages: &Value) -> Mapped {
        self.resync_in(child, messages, false)
    }

    fn resync_in(&mut self, session: &str, messages: &Value, seed: bool) -> Mapped {
        let mut out = Mapped::default();
        let call = if session == self.main {
            None
        } else {
            match self.children.get(session).and_then(|c| c.link.clone()) {
                Some(call) => Some(call),
                None => return out,
            }
        };
        let items: &[Value] = messages
            .get("data")
            .and_then(Value::as_array)
            .map_or(&[], Vec::as_slice);
        // newest first on the wire: what is newer than the first `idle` is the running turn
        let idle = items
            .iter()
            .position(|i| i.get("type").and_then(Value::as_str) == Some("idle"));
        for (k, item) in items.iter().enumerate().rev() {
            if item.get("type").and_then(Value::as_str) != Some("assistant") {
                continue;
            }
            let Some(message) = item.get("id").and_then(Value::as_str) else {
                continue;
            };
            let silent = seed && idle.is_some_and(|f| k > f);
            let (mut text_n, mut think_n) = (0u32, 0u32);
            for block in item["content"].as_array().into_iter().flatten() {
                match block.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        let n = text_n;
                        text_n += 1;
                        if self.shown.texts.insert((message.to_string(), n)) && !silent {
                            out.events.push(AgentEvent::Text {
                                message_id: message.to_string(),
                                block_index: n,
                                text: block["text"].as_str().unwrap_or("").to_string(),
                            });
                        }
                    }
                    Some("reasoning") => {
                        let n = think_n;
                        think_n += 1;
                        if self.shown.thinking.insert((message.to_string(), n)) && !silent {
                            let text = block["text"].as_str().unwrap_or("").to_string();
                            out.events.push(thinking(
                                message.to_string(),
                                n,
                                ThinkingPhase::Start,
                                String::new(),
                            ));
                            out.events.push(thinking(
                                message.to_string(),
                                n,
                                ThinkingPhase::End,
                                text,
                            ));
                        }
                    }
                    Some("tool") => {
                        self.resync_tool(session, call.as_deref(), message, block, silent, &mut out)
                    }
                    _ => {}
                }
            }
        }
        // the list says the turn ended and no event did
        if !seed && call.is_none() && self.turn_open {
            if let Some(i) = items.first().filter(|i| i["type"] == "idle") {
                let reason = match i["outcome"].as_str() {
                    Some("succeeded") => TurnFinishReason::Completed,
                    Some("interrupted") => TurnFinishReason::Interrupted,
                    _ => TurnFinishReason::Error,
                };
                let ended = i["time"]["created"].as_f64().unwrap_or(0.0);
                let errors = if reason == TurnFinishReason::Error {
                    vec!["The turn ended with an error".to_string()]
                } else {
                    Vec::new()
                };
                self.finish_turn(ended, reason, errors, &mut out);
            }
        }
        out
    }

    fn resync_tool(
        &mut self,
        session: &str,
        call: Option<&str>,
        message: &str,
        block: &Value,
        silent: bool,
        out: &mut Mapped,
    ) {
        let Some(id) = block.get("id").and_then(Value::as_str) else {
            return;
        };
        let name = block["name"].as_str().unwrap_or("").to_string();
        let state = &block["state"];
        let status = state["status"].as_str().unwrap_or("");
        let done = status == "completed" || status == "error";
        if silent {
            self.shown.tools.insert(id.to_string());
            if done {
                self.shown.finished.insert(id.to_string());
            }
            return;
        }
        // a call the events showed but never finished (the stream broke in between) still gets
        // its end here
        if self.shown.tools.insert(id.to_string()) {
            self.calls
                .insert(id.to_string(), (name.clone(), message.to_string()));
            out.events.push(AgentEvent::ToolCallStarted {
                tool_call_id: id.to_string(),
                message_id: message.to_string(),
                tool: name.clone(),
                parent_tool_call_id: call.map(String::from),
            });
            if let Some(input) = state.get("input") {
                self.inputs.insert(id.to_string(), input.clone());
                out.events.push(AgentEvent::ToolCallInput {
                    tool_call_id: id.to_string(),
                    input: input.clone(),
                });
            }
        }
        // a launch names its child session: link it, which releases what it held
        if let Some(child) = state["metadata"]["sessionID"].as_str() {
            self.link(session, child, id, out);
        }
        if self.shown.finished.contains(id) {
            return;
        }
        if let Some(calls) = state["metadata"]["toolCalls"].as_array() {
            self.show_rows(id, calls, out);
        }
        if done {
            let error = status == "error";
            self.settle_rows(id, &state["metadata"], error, out);
            let (output, kind) = if error {
                (
                    state["error"]["message"].as_str().unwrap_or("").to_string(),
                    Some(state["error"]["type"].as_str().unwrap_or("error")),
                )
            } else {
                (
                    text_of(state["content"].as_array().map_or(&[][..], Vec::as_slice)),
                    None,
                )
            };
            let truncated = state["metadata"]["truncated"].as_bool() == Some(true);
            self.finished(id.to_string(), output, kind, truncated, out);
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Helpers

/// The one place OpenCode's `<server>_<tool>` spelling is made from codemode's `<server>.<tool>`
/// (the spelling a direct call and a permission's action already use, and the table's MCP prefix).
fn inner_tool_name(tool: &str) -> String {
    tool.replace('.', "_")
}

fn protocol(message: String) -> AgentEvent {
    AgentEvent::Error {
        kind: AgentErrorKind::Protocol,
        message,
        retryable: false,
    }
}

fn thinking(
    message_id: String,
    block_index: u32,
    phase: ThinkingPhase,
    text: String,
) -> AgentEvent {
    AgentEvent::Thinking {
        message_id,
        block_index,
        phase,
        text,
        estimated_tokens: None,
    }
}

/// The session an event is about.
fn owner(event: &Event) -> Option<String> {
    Some(match event {
        Event::ExecutionStarted(e) => e.sessionID.clone(),
        Event::ExecutionSucceeded(e) => e.sessionID.clone(),
        Event::ExecutionFailed(e) => e.sessionID.clone(),
        Event::ExecutionInterrupted(e) => e.sessionID.clone(),
        Event::StepStarted(e) => e.sessionID.clone(),
        Event::StepEnded(e) => e.sessionID.clone(),
        Event::StepFailed(e) => e.sessionID.clone(),
        Event::TextDelta(e) => e.sessionID.clone(),
        Event::TextEnded(e) => e.sessionID.clone(),
        Event::ReasoningStarted(e) => e.sessionID.clone(),
        Event::ReasoningDelta(e) => e.sessionID.clone(),
        Event::ReasoningEnded(e) => e.sessionID.clone(),
        Event::ToolInputStarted(e) => e.sessionID.clone(),
        Event::ToolInputDelta(e) => e.sessionID.clone(),
        Event::ToolCalled(e) => e.sessionID.clone(),
        Event::ToolProgress(e) => e.sessionID.clone(),
        Event::ToolSuccess(e) => e.sessionID.clone(),
        Event::ToolFailed(e) => e.sessionID.clone(),
        Event::PermissionAsked(e) => e.sessionID.clone(),
        Event::PermissionReplied(e) => e.sessionID.clone(),
        Event::FormCreated(e) => e.form.sessionID.clone(),
        Event::FormReplied(e) => e.sessionID.clone(),
        Event::FormCancelled(e) => e.sessionID.clone(),
        Event::InboxEnqueued(e) => e.sessionID.clone(),
        Event::InboxDelivered(e) => e.sessionID.clone(),
        Event::InboxCancelled(e) => e.sessionID.clone(),
        Event::JobUpdated(e) => e.info.sessionID.clone(),
        Event::RetryScheduled(e) => e.sessionID.clone(),
        Event::ServerConnected(_) | Event::SessionCreated(_) | Event::Other(_) => return None,
    })
}

/// The text parts of a tool result, joined.
fn text_of(content: &[Value]) -> String {
    content
        .iter()
        .filter(|c| c.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|c| c.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n")
}

fn error_kind(e: &StructuredError) -> (AgentErrorKind, bool) {
    match e.kind.as_str() {
        "provider.auth" => (AgentErrorKind::Auth, false),
        k if k.starts_with("provider.") => (AgentErrorKind::Api, false),
        k if k.contains("rate") => (AgentErrorKind::RateLimit, true),
        _ => (AgentErrorKind::Unknown, false),
    }
}

/// OpenCode's own "Always": its `save` patterns as the one suggestion shape the web and
/// `permission_update` read (`addRules` for the project's saved rule, the same for the session,
/// and `setMode acceptEdits` for an edit action).
fn suggestions(action: &str, save: &[String]) -> Vec<Value> {
    if save.is_empty() {
        return Vec::new();
    }
    let rules: Vec<Value> = save
        .iter()
        .map(|pattern| json!({"toolName": action, "ruleContent": pattern}))
        .collect();
    let mut out = vec![json!({
        "type": "addRules",
        "rules": rules,
        "behavior": "allow",
        "destination": "localSettings",
    })];
    if action == "edit" {
        out.push(json!({"type": "setMode", "mode": "acceptEdits", "destination": "session"}));
    }
    out
}

/// The report inside `<background-result ...>\n<report>\n</background-result>`.
pub fn background_report(text: &str) -> Option<String> {
    let start = text.find("<background-result")?;
    let open_end = text[start..].find('>')? + start + 1;
    let end = text.rfind("</background-result>")?;
    (end >= open_end).then(|| text[open_end..end].trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_report_is_what_is_inside_the_background_result() {
        let text = "<background-result kind=\"subagent\" sessionID=\"ses_x\" state=\"completed\" description=\"d\">\nThe heading is Pets.\n</background-result>";
        assert_eq!(
            background_report(text).as_deref(),
            Some("The heading is Pets.")
        );
        assert_eq!(background_report("no tag"), None);
    }

    #[test]
    fn always_allow_keeps_the_shape_the_web_reads() {
        let s = suggestions("shell", &["echo *".into()]);
        assert_eq!(s.len(), 1);
        assert_eq!(s[0]["rules"][0]["ruleContent"], "echo *");
        assert_eq!(suggestions("edit", &["*".into()]).len(), 2);
        assert!(suggestions("read", &[]).is_empty());
    }
}
