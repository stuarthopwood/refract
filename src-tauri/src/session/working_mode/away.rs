// Away policy (#433, #2031): answers every request at once and denies approvals. Never approves,
// never cancels (a cancel stops the agent's turn), never starts a turn.
// Pure helpers are public so goal mode (#479) can reuse the same policy.

use serde_json::{json, Value};

use crate::session::agent::{AskQuestion, PendingRequest, SessionAgent, SessionStatus};

pub const ASK_FALLBACK: &str =
    "The user is away. Choose the best option yourself, state your choice, and continue.";
pub const APPROVAL_DENIAL: &str =
    "Not approved: the user is away. Pick a safe alternative or skip this step and continue.";
pub const ANSWERED_STEER: &str = "[Automatic, Away mode] Answered by Away Mode: the user is away. Proceed on your best judgement.";
pub const DENIED_STEER: &str = "[Automatic, Away mode] Not approved by Away Mode: the user is away. Pick a safe alternative or skip this step and continue.";

const STEER_TIMEOUT_MS: u64 = 60_000;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Answered,
    Denied,
}

#[derive(Clone)]
pub struct Entry {
    pub kind: Kind,
    pub question: String,
    pub outcome: String,
}

#[derive(Default)]
pub struct Log(Vec<Entry>);

impl Log {
    pub(super) fn push(&mut self, entry: Entry) {
        self.0.push(entry);
    }

    pub(super) fn take(&mut self) -> Vec<Entry> {
        std::mem::take(&mut self.0)
    }
}

/// The recommended option(s) for each question, or the fallback text when none is recommended.
/// A multi-select with per-option flags takes every flagged option (as "Use Recommended" does); otherwise the question-level index.
pub fn ask_answers(questions: &[AskQuestion]) -> Vec<Value> {
    questions
        .iter()
        .map(|q| {
            let flagged: Vec<&str> = q
                .options
                .iter()
                .filter(|option| option.recommended)
                .map(|option| option.label.as_str())
                .collect();
            if q.multi && !flagged.is_empty() {
                return json!({ "id": q.id, "selectedOptions": flagged });
            }
            let pick = q
                .recommended
                .and_then(|i| usize::try_from(i).ok())
                .and_then(|i| q.options.get(i));
            match pick {
                Some(option) => json!({ "id": q.id, "selectedOptions": [option.label] }),
                None => json!({ "id": q.id, "selectedOptions": [], "customInput": ASK_FALLBACK }),
            }
        })
        .collect()
}

fn describe_ask(questions: &[AskQuestion], answers: &[Value]) -> (String, String) {
    let asked = questions
        .iter()
        .map(|q| q.question.as_str())
        .collect::<Vec<_>>()
        .join(" / ");
    let chosen = answers
        .iter()
        .map(|a| {
            let picked: Vec<&str> = a
                .get("selectedOptions")
                .and_then(Value::as_array)
                .map(|items| items.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            if picked.is_empty() {
                "left to the agent".to_string()
            } else {
                picked.join(" + ")
            }
        })
        .collect::<Vec<_>>()
        .join(", ");
    (asked, chosen)
}

/// Puts a fixture agent in Away without the persistence `set_mode` does, so tests leave no data dir behind.
#[cfg(test)]
pub(in crate::session) async fn enter_for_test(agent: &SessionAgent) {
    agent
        .with_working_mode_state(|s| {
            s.loaded = true;
            s.mode = super::WorkingMode::Away;
        })
        .await;
}

/// Back to Interactive, for tests that compare a prompt before and after Away.
#[cfg(test)]
pub(in crate::session) async fn leave_for_test(agent: &SessionAgent) {
    agent
        .with_working_mode_state(|s| s.mode = super::WorkingMode::Interactive)
        .await;
}

/// Called after the request is registered; a no-op unless the Session is in Away mode.
pub(in crate::session) async fn on_request(agent: &SessionAgent, request: PendingRequest) {
    super::ensure_loaded(agent).await;
    if !super::is_away(agent).await {
        return;
    }
    match request {
        PendingRequest::Ask {
            request_id,
            questions,
            ..
        } => answer_ask(agent, request_id, questions).await,
        PendingRequest::Approval {
            request_id,
            tool,
            target,
            ..
        } => deny_approval(agent, request_id, format!("{tool} {target}")).await,
        PendingRequest::Question {
            request_id,
            title,
            options,
            input_kind,
            ..
        } => answer_question(agent, request_id, title, input_kind, options).await,
        PendingRequest::Form {
            request_id, html, ..
        } => answer_form(agent, request_id, &html).await,
    }
}

/// A cancelled dialog stops the agent's turn, so every dialog gets an answer: a select takes its
/// first option, a confirm says No (the safe answer), text gets the away reply.
async fn answer_question(
    agent: &SessionAgent,
    request_id: String,
    title: String,
    input_kind: &str,
    options: Vec<String>,
) {
    let (answer, outcome) = match (input_kind, options.first()) {
        ("text", _) => (
            json!({ "value": ASK_FALLBACK }),
            "the away reply".to_string(),
        ),
        ("confirm", _) => (json!({ "confirmed": false }), "No".to_string()),
        (_, Some(first)) => (json!({ "value": first }), first.clone()),
        // An empty select has nothing to pick, so the only reply left is the cancel.
        (_, None) => (
            json!({ "cancelled": true }),
            "no option to pick".to_string(),
        ),
    };
    match agent.answer_request(request_id, answer).await {
        Ok(()) => record(agent, Kind::Answered, title, outcome).await,
        Err(err) => log::warn!("away: could not answer question: {err}"),
    }
}

async fn answer_form(agent: &SessionAgent, request_id: String, html: &str) {
    let data = super::away_form::form_defaults(html);
    match agent
        .answer_request(request_id, json!({ "data": data }))
        .await
    {
        Ok(()) => {
            let title = "the agent's form".to_string();
            record(agent, Kind::Answered, title, "default values".to_string()).await
        }
        Err(err) => log::warn!("away: could not answer form: {err}"),
    }
}

/// Entering Away also covers requests already waiting.
pub(in crate::session) async fn sweep(agent: &SessionAgent) {
    for request in agent.pending_requests().await {
        on_request(agent, request).await;
    }
}

async fn answer_ask(agent: &SessionAgent, request_id: String, questions: Vec<AskQuestion>) {
    let answers = ask_answers(&questions);
    let (asked, chosen) = describe_ask(&questions, &answers);
    // The by-away helper, not JSON, tells the `refract_ask` result who answered (FR-139).
    match agent
        .answer_request_by_away(request_id, json!({ "answers": answers }))
        .await
    {
        Ok(()) => record(agent, Kind::Answered, asked, chosen).await,
        Err(err) => log::warn!("away: could not answer ask: {err}"),
    }
}

/// Denied at once: Refract has no dangerous-command detector, so the Approval path stays the gate.
async fn deny_approval(agent: &SessionAgent, request_id: String, what: String) {
    match agent
        .answer_request(request_id, json!({ "approve": false }))
        .await
    {
        Ok(()) => record(agent, Kind::Denied, what, APPROVAL_DENIAL.to_string()).await,
        Err(err) => log::warn!("away: could not deny approval: {err}"),
    }
}

async fn record(agent: &SessionAgent, kind: Kind, question: String, outcome: String) {
    let text = match kind {
        Kind::Answered => format!("Automatic (Away mode): answered \"{question}\" with {outcome}."),
        Kind::Denied => {
            format!("Automatic (Away mode): denied approval for \"{question}\". {outcome}")
        }
    };
    agent
        .with_working_mode_state(|s| {
            s.away.push(Entry {
                kind,
                question,
                outcome,
            })
        })
        .await;
    agent.lane_notice(text, "info").await;
    steer(agent, kind);
}

/// Tells the agent why it got an automatic reply. Spawned because the frame loop that raised the
/// request must keep reading the prompt's reply.
fn steer(agent: &SessionAgent, kind: Kind) {
    let message = match kind {
        Kind::Answered => ANSWERED_STEER,
        Kind::Denied => DENIED_STEER,
    };
    let agent = agent.arc();
    tokio::spawn(async move {
        if !matches!(
            agent.status().await,
            SessionStatus::Working | SessionStatus::NeedsYou
        ) {
            return;
        }
        let steer = json!({
            "type": "prompt",
            "message": message,
            "streamingBehavior": "steer",
        });
        let _ = agent.request_rpc(steer, STEER_TIMEOUT_MS).await;
    });
}

/// The "While you were away" card, posted when leaving Away.
pub(in crate::session) async fn summarise(agent: &SessionAgent) {
    let entries = agent.with_working_mode_state(|s| s.away.take()).await;
    let text = if entries.is_empty() {
        "While you were away: nothing needed you.".to_string()
    } else {
        let lines = entries
            .iter()
            .map(|e| match e.kind {
                Kind::Answered => format!("- Answered \"{}\" with {}.", e.question, e.outcome),
                Kind::Denied => format!("- Denied approval for \"{}\".", e.question),
            })
            .collect::<Vec<_>>()
            .join("\n");
        format!(
            "While you were away, {} automatic action(s):\n{lines}",
            entries.len()
        )
    };
    agent.lane_notice(text, "info").await;
}

#[cfg(test)]
#[path = "away.test.rs"]
mod tests;
