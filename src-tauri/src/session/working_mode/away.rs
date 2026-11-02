// Away policy (#433): answers asks at once and denies stale approvals. Never approves, never starts a turn.
// Pure helpers are public so goal mode (#479) can reuse the same policy.

use std::time::Duration;

use serde_json::{json, Value};

use crate::session::agent::{AskQuestion, PendingRequest, SessionAgent, SessionStatus};

pub const ASK_FALLBACK: &str =
    "The user is away. Choose the best option yourself, state your choice, and continue.";
pub const APPROVAL_DENIAL: &str =
    "Not approved: the user is away. Pick a safe alternative or skip this step and continue.";
pub const QUESTION_DECLINED: &str = "cancelled because the user is away";

const DEFAULT_APPROVAL_TIMEOUT: Duration = Duration::from_secs(5 * 60);
// Test-only: shortens the denial delay for the live check; debug builds only.
const TIMEOUT_ENV: &str = "REFRACT_AWAY_APPROVAL_TIMEOUT_MS";
const STEER_TIMEOUT_MS: u64 = 60_000;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Answered,
    Denied,
    Declined,
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

pub fn approval_timeout() -> Duration {
    if cfg!(debug_assertions) {
        if let Some(ms) = std::env::var(TIMEOUT_ENV)
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .filter(|ms| *ms > 0)
        {
            return Duration::from_millis(ms);
        }
    }
    DEFAULT_APPROVAL_TIMEOUT
}

/// The recommended option for each question, or the fallback text when none is recommended.
pub fn ask_answers(questions: &[AskQuestion]) -> Vec<Value> {
    questions
        .iter()
        .map(|q| {
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
            a.pointer("/selectedOptions/0")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| "left to the agent".to_string())
        })
        .collect::<Vec<_>>()
        .join(", ");
    (asked, chosen)
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
        } => watch_approval(agent, request_id, format!("{tool} {target}")).await,
        PendingRequest::Question {
            request_id,
            title,
            input_kind,
            ..
        } => answer_question(agent, request_id, title, input_kind == "text").await,
    }
}

// Free-text dialogs get the away reply; select/confirm may grant something, so they are cancelled, never picked.
async fn answer_question(agent: &SessionAgent, request_id: String, title: String, text: bool) {
    let (answer, kind, outcome) = if text {
        (json!({ "value": ASK_FALLBACK }), Kind::Answered, "the away reply")
    } else {
        (json!({ "cancelled": true }), Kind::Declined, QUESTION_DECLINED)
    };
    match agent.answer_request(request_id, answer).await {
        Ok(()) => record(agent, kind, title, outcome.to_string()).await,
        Err(err) => log::warn!("away: could not answer question: {err}"),
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
    match agent
        .answer_request(request_id, json!({ "answers": answers }))
        .await
    {
        Ok(()) => record(agent, Kind::Answered, asked, chosen).await,
        Err(err) => log::warn!("away: could not answer ask: {err}"),
    }
}

async fn watch_approval(agent: &SessionAgent, request_id: String, what: String) {
    let epoch = super::away_epoch(agent).await;
    let agent = agent.arc();
    tokio::spawn(async move {
        tokio::time::sleep(approval_timeout()).await;
        if !super::is_away(&agent).await || super::away_epoch(&agent).await != epoch {
            return;
        }
        // A request answered meanwhile is gone, so this errors and nothing is denied twice.
        if agent
            .answer_request(request_id, json!({ "approve": false }))
            .await
            .is_err()
        {
            return;
        }
        record(&agent, Kind::Denied, what, APPROVAL_DENIAL.to_string()).await;
        if matches!(
            agent.status().await,
            SessionStatus::Working | SessionStatus::NeedsYou
        ) {
            let steer = json!({
                "type": "prompt",
                "message": format!("[Automatic, Away mode] {APPROVAL_DENIAL}"),
                "streamingBehavior": "steer",
            });
            let _ = agent.request_rpc(steer, STEER_TIMEOUT_MS).await;
        }
    });
}

async fn record(agent: &SessionAgent, kind: Kind, question: String, outcome: String) {
    let text = match kind {
        Kind::Answered => format!("Automatic (Away mode): answered \"{question}\" with {outcome}."),
        Kind::Denied => {
            format!("Automatic (Away mode): denied approval for \"{question}\". {outcome}")
        }
        Kind::Declined => {
            format!("Automatic (Away mode): question \"{question}\" {outcome}.")
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
                Kind::Declined => format!("- Cancelled question \"{}\".", e.question),
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
