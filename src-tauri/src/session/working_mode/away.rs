// Away policy (#433, #2031): answers every request at once and denies approvals. Never approves,
// never cancels a request it can answer (a cancel stops the agent's turn), never starts a turn.
// The only cancels are the ones with nothing to answer with; each is logged and steered.
// Pure helpers are public so goal mode (#479) can reuse the same policy.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use serde_json::{json, Value};
use unicode_normalization::UnicodeNormalization;

use crate::session::agent::{AskQuestion, PendingRequest, SessionAgent, SessionStatus};

pub const ASK_FALLBACK: &str =
    "The user is away. Choose the best option yourself, state your choice, and continue.";
pub const APPROVAL_DENIAL: &str =
    "Not approved: the user is away. Pick a safe alternative or skip this step and continue.";
pub const ANSWERED_STEER: &str = "[Automatic, Away mode] Answered by Away Mode: the user is away. Proceed on your best judgement.";
pub const DENIED_STEER: &str = "[Automatic, Away mode] Not approved by Away Mode: the user is away. Pick a safe alternative or skip this step and continue.";
pub const CANCELLED_STEER: &str = "[Automatic, Away mode] Your dialog had nothing Away Mode could answer it with, so it was cancelled: the user is away. Proceed on your best judgement.";

const STEER_TIMEOUT_MS: u64 = 60_000;
const LOG_CAP: usize = 200;
const TEXT_CAP: usize = 200;

/// Labels that read as the cautious answer; matched at the start of a label on a word boundary, or
/// as the whole label.
const SAFE_PREFIXES: [&str; 23] = [
    "no", "nope", "none", "never", "not now", "not yet", "deny", "decline", "disallow", "refuse",
    "reject", "block", "cancel", "abort", "stop", "dismiss", "skip", "later", "stay", "refine",
    "don't", "do not", "keep",
];
/// A label longer than this cannot be a bare negative word, and the cap bounds the folding work.
const LABEL_CAP: usize = 64;
/// Lead words that negate an approving word right after them ("Never allow"). Every prefix also has
/// to pass the short-refusal check, since "No more prompts - always allow" and "Skip confirmations
/// from now on" open with a negative word yet approve or set a standing rule.
const NEGATING_LEADS: [&str; 4] = ["never", "stop", "don't", "do not"];
const SHORT_REFUSAL_WORDS: usize = 4;
const APPROVING: [&str; 5] = ["allow", "always", "approv", "yes", "trust"];
const STANDING: &[&str] = &["ask", "again", "remember", "prompt", "warn", "notif"];
/// Approving words a negating lead word cancels when they come right after it.
const NEGATED_BY_LEAD: [&str; 3] = ["allow", "approv", "trust"];

/// Declaration order is the strength order a steer coalesces by: Denied > Cancelled > Answered.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Kind {
    Answered,
    Cancelled,
    Denied,
}

#[derive(Clone)]
pub struct Entry {
    pub kind: Kind,
    pub question: String,
    pub outcome: String,
}

#[derive(Default)]
pub struct Log {
    entries: Vec<Entry>,
    dropped: usize,
    steer: Arc<SteerSlot>,
}

impl Log {
    /// Past the cap an entry is only counted, so a long Away stretch cannot grow the log without bound.
    pub(super) fn push(&mut self, entry: Entry) {
        if self.entries.len() < LOG_CAP {
            self.entries.push(entry);
        } else {
            self.dropped += 1;
        }
    }

    pub(super) fn take(&mut self) -> (Vec<Entry>, usize) {
        (
            std::mem::take(&mut self.entries),
            std::mem::take(&mut self.dropped),
        )
    }

    fn steer_slot(&self) -> Arc<SteerSlot> {
        Arc::clone(&self.steer)
    }
}

/// Whether a steer is in flight, and the strongest kind that asked for one meanwhile. Behind a std
/// mutex that is never held across an await, so `SteerGuard` can release it from `Drop`.
#[derive(Default)]
struct SteerSlot(Mutex<SteerState>);

#[derive(Default)]
struct SteerState {
    in_flight: bool,
    pending: Option<Kind>,
}

impl SteerSlot {
    fn state(&self) -> MutexGuard<'_, SteerState> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The guard for the caller that now owns the slot; `None` while a steer is in flight, after
    /// noting `kind` so the owner sends one more steer of the strongest kind it missed.
    fn begin(self: &Arc<Self>, kind: Kind) -> Option<SteerGuard> {
        let mut state = self.state();
        if state.in_flight {
            state.pending = state.pending.max(Some(kind));
            return None;
        }
        state.in_flight = true;
        Some(SteerGuard {
            slot: Arc::clone(self),
            held: true,
        })
    }
}

/// Owns the steer slot; dropping it (normally, on panic or when the task is aborted) frees the slot.
struct SteerGuard {
    slot: Arc<SteerSlot>,
    held: bool,
}

impl SteerGuard {
    /// The kind to steer once more, or `None` after releasing the slot. Deciding and releasing under
    /// one lock means no request can note a kind in between and then be left unsent.
    fn next(&mut self) -> Option<Kind> {
        let mut state = self.slot.state();
        let more = state.pending.take();
        if more.is_none() {
            state.in_flight = false;
            self.held = false;
        }
        more
    }
}

impl Drop for SteerGuard {
    fn drop(&mut self) {
        if self.held {
            let mut state = self.slot.state();
            state.in_flight = false;
            state.pending = None;
        }
    }
}

/// Zero-width, bidi, joiner, filler, variation-selector and tag characters hide in front of a label
/// without changing how it reads.
fn is_format(c: char) -> bool {
    matches!(
        c,
        '\u{00ad}' | '\u{034f}' | '\u{061c}' | '\u{115f}' | '\u{1160}' | '\u{180e}'
            | '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2060}'..='\u{2064}'
            | '\u{2066}'..='\u{206f}' | '\u{3164}' | '\u{fe00}'..='\u{fe0f}' | '\u{feff}'
            | '\u{ffa0}' | '\u{e0000}'..='\u{e007f}'
    )
}

/// NFKC-folded, format-stripped, lower-cased label with single spaces and straight apostrophes, and
/// whether it was longer than `LABEL_CAP`. Format characters go before the cap, so padding a label
/// with them can neither push its text past the cap nor out of it.
fn fold(label: &str) -> (String, bool) {
    let mut visible = label.chars().filter(|c| !is_format(*c));
    let head: String = visible.by_ref().take(LABEL_CAP).collect();
    let truncated = visible.next().is_some();
    let folded: String = head
        .nfkc()
        .filter(|c| !is_format(*c))
        .flat_map(char::to_lowercase)
        .map(|c| match c {
            '\u{2018}' | '\u{2019}' | '\u{02bc}' => '\'',
            c => c,
        })
        .collect();
    (
        folded.split_whitespace().collect::<Vec<_>>().join(" "),
        truncated,
    )
}

/// The text after `prefix` when the prefix ends on a word boundary.
fn after_word<'a>(folded: &'a str, prefix: &str) -> Option<&'a str> {
    folded
        .strip_prefix(prefix)
        .filter(|rest| rest.chars().next().is_none_or(|c| !c.is_alphanumeric()))
}

fn words(text: &str) -> impl Iterator<Item = &str> {
    text.split(|c: char| !c.is_alphanumeric() && c != '\'')
        .filter(|word| !word.is_empty())
}

/// "Never ask again" and "Stop asking" are standing instructions, not a refusal of this request, and
/// "Don't ask again - always allow" or "Keep allowing" approves it. So a prefix reads as a refusal
/// only in a short phrase with no approving or standing-instruction word; "Don't allow" is fine
/// because a negating lead word cancels the word right after it.
fn is_short_refusal(prefix: &str, folded: &str, rest: &str) -> bool {
    if folded.split_whitespace().count() > SHORT_REFUSAL_WORDS {
        return false;
    }
    let mut rest_words = words(rest).peekable();
    if NEGATING_LEADS.contains(&prefix)
        && rest_words
            .peek()
            .is_some_and(|first| NEGATED_BY_LEAD.iter().any(|w| first.starts_with(w)))
    {
        rest_words.next();
    }
    !rest_words.any(|word| {
        APPROVING
            .iter()
            .chain(STANDING)
            .any(|marker| word.starts_with(marker))
    })
}

fn starts_with_negative(folded: &str) -> bool {
    SAFE_PREFIXES.iter().any(|prefix| {
        after_word(folded, prefix).is_some_and(|rest| is_short_refusal(prefix, folded, rest))
    })
}

fn is_bare_negative(folded: &str) -> bool {
    SAFE_PREFIXES.contains(&folded.trim_end_matches(|c: char| !c.is_alphanumeric()))
}

/// The position of the label that reads as the cautious answer, if any: a label that is a negative
/// word on its own ("No", "Deny.") beats the first one that merely starts with one ("Skip tests and
/// deploy").
pub fn negative_position<'a>(labels: impl IntoIterator<Item = &'a str>) -> Option<usize> {
    let mut first_prefixed = None;
    for (i, label) in labels.into_iter().enumerate() {
        let (folded, truncated) = fold(label);
        if !truncated && is_bare_negative(&folded) {
            return Some(i);
        }
        if first_prefixed.is_none() && starts_with_negative(&folded) {
            first_prefixed = Some(i);
        }
    }
    first_prefixed
}

/// The position of the label that reads as the safe (negative) answer, else the first label; `None`
/// when there are no labels. An unattended pick must not approve, so "Yes" never beats "No".
pub fn safe_position<'a>(labels: impl IntoIterator<Item = &'a str>) -> Option<usize> {
    let labels: Vec<&str> = labels.into_iter().collect();
    negative_position(labels.iter().copied()).or_else(|| (!labels.is_empty()).then_some(0))
}

fn clip(text: &str) -> String {
    match text.char_indices().nth(TEXT_CAP) {
        Some((end, _)) => format!("{}…", &text[..end]),
        None => text.to_string(),
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

/// Whether no steer is in flight or waiting, so a test knows the coalescing has run its course.
#[cfg(test)]
pub(in crate::session) async fn steer_idle(agent: &SessionAgent) -> bool {
    let slot = agent.with_working_mode_state(|s| s.away.steer_slot()).await;
    let state = slot.state();
    !state.in_flight && state.pending.is_none()
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
/// safe (negative) option, a confirm says No, text gets the away reply.
async fn answer_question(
    agent: &SessionAgent,
    request_id: String,
    title: String,
    input_kind: &str,
    options: Vec<String>,
) {
    let (answer, kind, outcome) = match input_kind {
        "text" => (
            json!({ "value": ASK_FALLBACK }),
            Kind::Answered,
            "the away reply".to_string(),
        ),
        "confirm" => (
            json!({ "confirmed": false }),
            Kind::Answered,
            "No".to_string(),
        ),
        _ => match safe_position(options.iter().map(String::as_str)) {
            Some(i) => (
                json!({ "value": options[i] }),
                Kind::Answered,
                options[i].clone(),
            ),
            // An empty select has nothing to pick, so the only reply left is the cancel.
            None => (
                json!({ "cancelled": true }),
                Kind::Cancelled,
                "no option to pick, so it was cancelled".to_string(),
            ),
        },
    };
    match agent.answer_request(request_id, answer).await {
        Ok(()) => record(agent, kind, title, outcome).await,
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
    let (question, outcome) = (clip(&question), clip(&outcome));
    let text = match kind {
        Kind::Answered => format!("Automatic (Away mode): answered \"{question}\" with {outcome}."),
        Kind::Denied => {
            format!("Automatic (Away mode): denied approval for \"{question}\". {outcome}")
        }
        Kind::Cancelled => {
            format!("Automatic (Away mode): cancelled \"{question}\": {outcome}.")
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
    let agent = agent.arc();
    tokio::spawn(async move { send_steer(&agent, kind).await });
}

/// One steer at a time: replies that land while it is in flight ride on one more steer of the
/// strongest kind among them, sent when it ends, instead of piling up.
pub(in crate::session) async fn send_steer(agent: &SessionAgent, kind: Kind) {
    let slot = agent.with_working_mode_state(|s| s.away.steer_slot()).await;
    let Some(mut guard) = slot.begin(kind) else {
        return;
    };
    let mut kind = kind;
    loop {
        deliver_steer(agent, kind).await;
        match guard.next() {
            Some(more) => kind = more,
            None => return,
        }
    }
}

async fn deliver_steer(agent: &SessionAgent, kind: Kind) {
    // A steer queued while Away can outlive it: leaving Away must not be followed by a message
    // that tells the agent the user is away.
    if !super::is_away(agent).await {
        return;
    }
    // Not atomic with the send below: a turn can settle in between. Accepted, the window is
    // milliseconds and closing it would hold a lock across the RPC.
    if !matches!(
        agent.status().await,
        SessionStatus::Working | SessionStatus::NeedsYou
    ) {
        return;
    }
    let message = match kind {
        Kind::Answered => ANSWERED_STEER,
        Kind::Denied => DENIED_STEER,
        Kind::Cancelled => CANCELLED_STEER,
    };
    let steer = json!({
        "type": "prompt",
        "message": message,
        "streamingBehavior": "steer",
    });
    let _ = agent.request_rpc(steer, STEER_TIMEOUT_MS).await;
}

/// For dialogs Refract cannot answer at all (malformed, unsupported); the caller still cancels them.
/// Returns whether Away Mode handled the notice, so the caller skips its own.
pub(in crate::session) async fn on_unanswerable(agent: &SessionAgent, what: String) -> bool {
    super::ensure_loaded(agent).await;
    if !super::is_away(agent).await {
        return false;
    }
    let outcome = "nothing to answer it with, so it was cancelled".to_string();
    record(agent, Kind::Cancelled, what, outcome).await;
    true
}

/// The "While you were away" card, posted when leaving Away.
pub(in crate::session) async fn summarise(agent: &SessionAgent) {
    let (entries, dropped) = agent.with_working_mode_state(|s| s.away.take()).await;
    agent
        .lane_notice(summary_text(&entries, dropped), "info")
        .await;
}

fn summary_text(entries: &[Entry], dropped: usize) -> String {
    if entries.is_empty() {
        return "While you were away: nothing needed you.".to_string();
    }
    let mut lines: Vec<String> = entries
        .iter()
        .map(|e| match e.kind {
            Kind::Answered => format!("- Answered \"{}\" with {}.", e.question, e.outcome),
            Kind::Denied => format!("- Denied approval for \"{}\".", e.question),
            Kind::Cancelled => format!("- Cancelled \"{}\": {}.", e.question, e.outcome),
        })
        .collect();
    if dropped > 0 {
        lines.push(format!("- +{dropped} more"));
    }
    format!(
        "While you were away, {} automatic action(s):\n{}",
        entries.len() + dropped,
        lines.join("\n")
    )
}

#[cfg(test)]
#[path = "away.test.rs"]
mod tests;
