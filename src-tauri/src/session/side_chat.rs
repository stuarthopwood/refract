// Side chat (`/btw`) and word prediction. Uses OMP's native `btw` RPC and frames directly.
// The lane hooks (`on_frame`, `on_exit`, `on_conversation_reset`) are called from `agent`.

use serde_json::{json, Value};

use crate::omp::process::ReadyWaitStage;

use super::agent::{AgentError, SessionAgent};

/// Matches `agent::mod`'s private `DEFAULT_REQUEST_TIMEOUT_MS`.
const REQUEST_TIMEOUT_MS: u64 = 60_000;
/// Allows for a cold shared prediction daemon start.
const PREDICT_WORD_TIMEOUT_MS: u64 = 150_000;

/// Side chat runtime state, held inside `AgentState`.
#[derive(Default)]
pub(super) struct State {
    /// Bumped on each Conversation change; topics stamped with an older value are stale.
    conversation_epoch: u64,
    /// Conversation epoch per active topic root id; removed once the topic is terminal.
    topic_epoch: std::collections::HashMap<String, u64>,
    /// Tombstones for terminal topics, so a late frame still reads as stale after a switch (#789).
    terminal_topic_epoch: std::collections::HashMap<String, u64>,
    /// FIFO order for `terminal_topic_epoch` eviction.
    terminal_topic_order: std::collections::VecDeque<String>,
}

/// Flattens one topic thread into ordered records. Every record carries the root's `topicId`.
/// Non-root ids are synthetic (`${parent}.${index}`) and must never be sent back to OMP.
fn flatten_btw_history(thread: &Value) -> Vec<Value> {
    let topic_id = thread.get("id").and_then(Value::as_str).unwrap_or("");
    let mut out = Vec::new();
    visit_btw_node(
        thread,
        topic_id,
        topic_id,
        thread.get("leafId").and_then(Value::as_str),
        &mut out,
    );
    out
}

fn visit_btw_node(
    node: &Value,
    id: &str,
    topic_id: &str,
    leaf_id: Option<&str>,
    out: &mut Vec<Value>,
) {
    let mut record = json!({
        "id": id,
        "topicId": topic_id,
        "status": node.get("status").cloned().unwrap_or(Value::Null),
        "question": node.get("question").cloned().unwrap_or(Value::Null),
        "answer": node.get("answer").cloned().unwrap_or(Value::Null),
        "createdAt": node.get("createdAt").cloned().unwrap_or(Value::Null),
        "updatedAt": node.get("updatedAt").cloned().unwrap_or(Value::Null),
    });
    // Optional fields are omitted, not sent as `null`.
    if let Some(error) = node.get("error").and_then(Value::as_str) {
        record["error"] = Value::String(error.to_string());
    }
    if let Some(leaf_id) = leaf_id {
        record["leafId"] = Value::String(leaf_id.to_string());
    }
    out.push(record);
    if let Some(follow_ups) = node.get("followUps").and_then(Value::as_array) {
        for (index, child) in follow_ups.iter().enumerate() {
            let child_id = format!("{id}.{index}");
            visit_btw_node(child, &child_id, topic_id, None, out);
        }
    }
}

/// Returns the thread's latest turn (the last flattened entry). A live response repeats the root's
/// question and answer, so the root row is never the one to show.
fn latest_turn(thread: &Value) -> Value {
    let mut flattened = flatten_btw_history(thread);
    // `flatten_btw_history` always visits the root first, so `flattened` is never empty.
    flattened.pop().unwrap_or(Value::Null)
}

/// Whether a topic stamped with `topic_epoch` is stale after a Conversation switch.
fn topic_frame_is_stale(topic_epoch: u64, conversation_epoch: u64) -> bool {
    topic_epoch < conversation_epoch
}

/// Whether a topic's `topic_epoch` entry can be removed: true once its status is no longer running.
fn turn_reached_terminal(status: &str) -> bool {
    status != "running"
}

/// Terminal records and notices always forward, even when hidden, so a completion is never lost.
/// Live deltas are gated on visibility.
fn should_forward_side_chat_patch(has_record_or_notice: bool, is_visible: bool) -> bool {
    has_record_or_notice || is_visible
}

/// Epoch for staleness checks: the active entry, else the tombstone, else the current epoch.
fn resolve_topic_epoch(state: &State, topic_id: &str) -> u64 {
    state
        .topic_epoch
        .get(topic_id)
        .or_else(|| state.terminal_topic_epoch.get(topic_id))
        .copied()
        .unwrap_or(state.conversation_epoch)
}

/// FIFO cap for `State::terminal_topic_epoch`, so tombstones cannot grow without bound.
const MAX_TOMBSTONES: usize = 256;

/// Tombstones a terminal topic, evicting the oldest entry past `MAX_TOMBSTONES`.
fn tombstone_topic(state: &mut State, topic_id: String, epoch: u64) {
    if state
        .terminal_topic_epoch
        .insert(topic_id.clone(), epoch)
        .is_none()
    {
        state.terminal_topic_order.push_back(topic_id);
    }
    while state.terminal_topic_order.len() > MAX_TOMBSTONES {
        if let Some(oldest) = state.terminal_topic_order.pop_front() {
            state.terminal_topic_epoch.remove(&oldest);
        }
    }
}

/// What `on_frame` must forward to the renderer as a `side-chat:patch`, if anything.
#[derive(Debug, PartialEq)]
pub(super) enum SideChatPatch {
    Delta { delta: String, record_id: String },
    Record { record: Value },
    Notice { message: String },
}

/// Pure core of `on_frame`. Mutates `state` as the live path does and returns what to forward,
/// or `None` if the frame is dropped.
pub(super) fn apply_frame(
    state: &mut State,
    frame_type: &str,
    frame: &Value,
    is_visible: bool,
) -> Option<SideChatPatch> {
    match frame_type {
        "notice" => {
            // Only `btw-history` notices belong to side chat; others stay in the main transcript.
            if frame.get("source").and_then(Value::as_str) != Some("btw-history") {
                return None;
            }
            let message = frame.get("message").and_then(Value::as_str)?;
            should_forward_side_chat_patch(true, is_visible).then_some(SideChatPatch::Notice {
                message: message.to_string(),
            })
        }
        "btw_delta" => {
            let record_id = frame.get("recordId").and_then(Value::as_str)?;
            let delta = frame.get("delta").and_then(Value::as_str)?;
            let topic_epoch = resolve_topic_epoch(state, record_id);
            if topic_frame_is_stale(topic_epoch, state.conversation_epoch) {
                return None;
            }
            should_forward_side_chat_patch(false, is_visible).then_some(SideChatPatch::Delta {
                delta: delta.to_string(),
                record_id: record_id.to_string(),
            })
        }
        "btw_record" => {
            let record = frame.get("record")?;
            let topic_id = record.get("id").and_then(Value::as_str)?.to_string();
            let topic_epoch = resolve_topic_epoch(state, &topic_id);
            let stale = topic_frame_is_stale(topic_epoch, state.conversation_epoch);
            let turn = latest_turn(record);
            let status = turn.get("status").and_then(Value::as_str).unwrap_or("");
            if turn_reached_terminal(status) {
                if let Some(removed_epoch) = state.topic_epoch.remove(&topic_id) {
                    tombstone_topic(state, topic_id, removed_epoch);
                }
            }
            if stale {
                return None;
            }
            should_forward_side_chat_patch(true, is_visible)
                .then_some(SideChatPatch::Record { record: turn })
        }
        _ => None,
    }
}

pub(super) async fn on_frame(agent: &SessionAgent, frame_type: &str, frame: &Value) {
    let is_visible = agent.is_visible();
    let patch = agent
        .with_side_chat_state(|s| apply_frame(s, frame_type, frame, is_visible))
        .await;
    match patch {
        Some(SideChatPatch::Delta { delta, record_id }) => agent
            .events()
            .emit_side_chat_patch_delta(agent.session_id(), &delta, &record_id),
        Some(SideChatPatch::Record { record }) => agent
            .events()
            .emit_side_chat_patch_record(agent.session_id(), &record),
        Some(SideChatPatch::Notice { message }) => agent
            .events()
            .emit_side_chat_patch_notice(agent.session_id(), &message),
        None => {}
    }
}

/// Clears side-chat state on exit so a running record cannot block a new process.
pub(super) async fn on_exit(agent: &SessionAgent, _code: Option<i32>, _requested: bool) {
    agent
        .with_side_chat_state(|s| {
            s.topic_epoch.clear();
            s.terminal_topic_epoch.clear();
            s.terminal_topic_order.clear();
        })
        .await;
    agent
        .events()
        .emit_side_chat_interrupted(agent.session_id());
}

pub(super) async fn on_start_progress(
    _agent: &SessionAgent,
    _stage: ReadyWaitStage,
    _elapsed_ms: u64,
) {
    // No side-chat behaviour ties to the ready-wait banner.
}

/// Bumps the Conversation epoch and tells the renderer the side-chat Conversation changed.
pub(super) async fn on_conversation_reset(agent: &SessionAgent) {
    agent
        .with_side_chat_state(|s| {
            s.conversation_epoch = s.conversation_epoch.wrapping_add(1);
        })
        .await;
    agent
        .events()
        .emit_side_chat_conversation_changed(agent.session_id());
}

/// Resets side-chat state after a stopped Session switches Conversation. Runs before `launch()`,
/// so a failed start still gets the reset.
pub(crate) async fn reset_after_start_with_conversation(
    agent: &SessionAgent,
    file: Option<&str>,
    previous_conversation: Option<Option<String>>,
) {
    let Some(previous_conversation) = previous_conversation else {
        return;
    };
    if file.is_none() || file != previous_conversation.as_deref() {
        on_conversation_reset(agent).await;
    }
}

/// Captures the epoch before the request is sent, so a Conversation switch during the request
/// leaves the topic stamped with the old epoch.
fn stamp_continuation_before_ask(state: &mut State, record_id: Option<&str>) -> u64 {
    let epoch = state.conversation_epoch;
    if let Some(record_id) = record_id {
        state.topic_epoch.insert(record_id.to_string(), epoch);
    }
    epoch
}

/// Stamps the topic's root id with the epoch captured before the request, never a re-read value.
fn stamp_topic_after_response(state: &mut State, thread_id: String, epoch: u64) {
    state.topic_epoch.insert(thread_id, epoch);
}

/// Issues `btw` and returns the `running` record. The answer arrives later as a `btw_record` patch.
pub async fn ask(
    agent: &SessionAgent,
    question: String,
    record_id: Option<String>,
) -> Result<Value, AgentError> {
    let record_id_ref = record_id.as_deref();
    let epoch = agent
        .with_side_chat_state(|s| stamp_continuation_before_ask(s, record_id_ref))
        .await;
    let mut cmd = json!({ "type": "btw", "question": question });
    if let Some(record_id) = &record_id {
        cmd["recordId"] = Value::String(record_id.clone());
    }
    let res = match agent.request_rpc(cmd, REQUEST_TIMEOUT_MS).await {
        Ok(res) => res,
        Err(err) => {
            forget_topic_epoch(agent, &record_id, epoch).await;
            return Err(err);
        }
    };
    if res.get("success").and_then(Value::as_bool) != Some(true) {
        let message = res
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("unknown error");
        forget_topic_epoch(agent, &record_id, epoch).await;
        return Err(AgentError::new(
            "prompt-failed",
            format!("btw failed: {message}"),
        ));
    }
    let Some(thread) = res.get("data").and_then(|d| d.get("record")) else {
        forget_topic_epoch(agent, &record_id, epoch).await;
        return Err(AgentError::new(
            "prompt-failed",
            "btw succeeded but returned no record",
        ));
    };
    let thread_id = thread
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    agent
        .with_side_chat_state(|s| stamp_topic_after_response(s, thread_id, epoch))
        .await;
    Ok(json!({ "record": latest_turn(thread) }))
}

/// Removes a failed continuation's epoch stamp, but only if it still holds this call's value.
async fn forget_topic_epoch(agent: &SessionAgent, record_id: &Option<String>, epoch: u64) {
    if let Some(record_id) = record_id {
        agent
            .with_side_chat_state(|s| {
                if s.topic_epoch.get(record_id) == Some(&epoch) {
                    s.topic_epoch.remove(record_id);
                }
            })
            .await;
    }
}

/// Cancels the running side question. A no-op if nothing is running.
pub async fn cancel(agent: &SessionAgent) -> Result<(), AgentError> {
    let res = match agent
        .request_rpc(json!({ "type": "btw_cancel" }), REQUEST_TIMEOUT_MS)
        .await
    {
        Ok(res) => res,
        Err(err) if err.code == "agent-not-running" => return Ok(()),
        Err(err) => return Err(err),
    };
    if res.get("success").and_then(Value::as_bool) != Some(true) {
        let message = res
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("unknown error");
        return Err(AgentError::new(
            "prompt-failed",
            format!("btw_cancel failed: {message}"),
        ));
    }
    Ok(())
}

/// Flattens OMP's per-topic history into records. Sorted oldest first, since OMP returns newest first.
pub async fn history(agent: &SessionAgent) -> Result<Vec<Value>, AgentError> {
    let res = agent
        .request_rpc(json!({ "type": "get_btw_history" }), REQUEST_TIMEOUT_MS)
        .await?;
    if res.get("success").and_then(Value::as_bool) != Some(true) {
        let message = res
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("unknown error");
        return Err(AgentError::new(
            "prompt-failed",
            format!("get_btw_history failed: {message}"),
        ));
    }
    let threads: Vec<Value> = res
        .get("data")
        .and_then(|d| d.get("records"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Ok(sort_and_flatten_threads(threads))
}

/// Sorts topics oldest first by `createdAt`, then flattens them into records.
fn sort_and_flatten_threads(mut threads: Vec<Value>) -> Vec<Value> {
    threads.sort_by(|a, b| {
        let a = a.get("createdAt").and_then(Value::as_f64).unwrap_or(0.0);
        let b = b.get("createdAt").and_then(Value::as_f64).unwrap_or(0.0);
        a.total_cmp(&b)
    });
    threads.iter().flat_map(flatten_btw_history).collect()
}

/// Ghost-text completion. Runs only on a live process, since a cold start can take about 150 s.
/// Any failure returns `None`.
pub async fn predict_word(agent: &SessionAgent, text: String, cursor: i64) -> Option<String> {
    let res = agent
        .request_rpc(
            json!({ "type": "predict_word", "text": text, "cursor": cursor }),
            PREDICT_WORD_TIMEOUT_MS,
        )
        .await
        .ok()?;
    if res.get("success").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    res.get("data")
        .and_then(|d| d.get("suffix"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// Best-effort feedback for `predict_word`. Failures are dropped silently.
pub async fn predict_word_feedback(
    agent: &SessionAgent,
    text: String,
    cursor: i64,
    suggestion: String,
    accepted: bool,
) {
    let _ = agent
        .request_rpc(
            json!({
                "type": "predict_word_feedback",
                "text": text,
                "cursor": cursor,
                "suggestion": suggestion,
                "accepted": accepted,
            }),
            REQUEST_TIMEOUT_MS,
        )
        .await;
}

#[cfg(test)]
#[path = "side_chat.test.rs"]
mod tests;
