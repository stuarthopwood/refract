// Side chat (`/btw`) and word prediction with its off switch (#772) (lane R6, issue #789). Port
// of `src/main/omp/SessionAgent.ts`'s own `askSideChat`/`cancelSideChat`/`getSideChatHistory`/
// `flattenBtwHistory`/`latestTurn`/`notifySideChatConversationChanged`/`predictWord`/
// `predictWordFeedback` plus its `onFrame` `btw_delta`/`btw_record`/btw-history-`notice` cases --
// side chat uses OMP's native `btw` RPC and frames directly (`rpc.md` "Side questions"/"Word
// prediction"), never a bundled extension. The IPC-facing sibling is `ipc/side_chat.rs`.
//
// `on_frame` is the one extension point `agent::frame`'s own `handle_frame` calls for every
// decoded frame, `on_exit` for process exit (`agent::launch`'s own `spawn_frame_listener`), and
// `on_start_progress` for the ready-wait banner (same listener). `on_conversation_reset` is the
// sibling hook `session::agent::conversations`'s own `start_new_conversation`/`open_conversation`
// call (issue #577/#712's own precedent, `session::readout`/`session::subagents`), the Rust home
// for `notifySideChatConversationChanged`.

use serde_json::{json, Value};

use crate::omp::process::ReadyWaitStage;

use super::agent::{AgentError, SessionAgent};

/// Mirrors `agent::mod`'s own `DEFAULT_REQUEST_TIMEOUT_MS` (private there); re-declared here with
/// the same value, the convention every lane module takes for a constant it does not export.
const REQUEST_TIMEOUT_MS: u64 = 60_000;
/// Port of `SessionAgent.ts`'s own `PREDICT_WORD_TIMEOUT_MS`: "about two minutes worst case" to
/// cover a cold shared prediction daemon start (`rpc.md` "Word prediction", FINDINGS item 28).
const PREDICT_WORD_TIMEOUT_MS: u64 = 150_000;

/// Lane R6's own runtime state, held inside `AgentState` by `agent/mod.rs` without that file ever
/// needing to change when this lane adds a field here. Reachable through `SessionAgent`'s own
/// `with_side_chat_state` accessor (`agent/mod.rs`).
#[derive(Default)]
pub(super) struct State {
    /// Port of `SessionAgent.ts`'s own `sideChatConversationEpoch`: bumped once per Conversation
    /// change (`on_conversation_reset` below). `ask` stamps every topic (root) id it learns about
    /// with the value current at ask-time.
    conversation_epoch: u64,
    /// Port of `SessionAgent.ts`'s own `sideChatTopicEpoch`, keyed by a topic's root id (never a
    /// flattened follow-up's own synthetic id, never `leafId`). Gate-fix (round 9): bounded by
    /// SETTLEDNESS, not by age -- `on_frame`'s own `btw_record` case deletes an entry once that
    /// topic's LATEST TURN reaches a terminal status, regardless of how many Conversation
    /// switches have happened since it was stamped; `on_exit` clears the whole map unconditionally
    /// on every process exit (nothing stamped here survives into a new process's own history).
    topic_epoch: std::collections::HashMap<String, u64>,
}

// ---------------------------------------------------------------------------
// Flatten / latest-turn (port of `SessionAgent.ts`'s own `flattenBtwHistory`/`latestTurn`)
// ---------------------------------------------------------------------------

/// Turns one `get_btw_history`/`btw`/`btw_record` topic thread (a `BtwHistoryThread`-shaped root
/// node plus its nested `followUps[]`) into the flat, ordered `SideChatRecord[]` the IPC contract
/// and renderer actually consume -- confirmed live (per `SessionAgent.ts`'s own doc comment) that
/// OMP returns one entry per independent topic, each a TREE, never a flat list. A non-root node
/// carries no real id of its own, so each is given a stable, position-derived `${id}.${index}`
/// key built from its OWN PARENT's id (never the root's id directly past the first level) --
/// safe as a list key, but this synthetic id must never be sent back to OMP as a `recordId`.
/// Every flattened record also carries `topicId` (the thread's own root `id`) -- that is the one
/// value a continuation (`ask`'s own `recordId`) or a cross-reference (`on_frame`'s own epoch
/// guard) ever uses, never a flattened non-root row's own `id` and never the root's `leafId`.
fn flatten_btw_history(thread: &Value) -> Vec<Value> {
    let topic_id = thread.get("id").and_then(Value::as_str).unwrap_or("");
    let mut out = Vec::new();
    visit_btw_node(thread, topic_id, topic_id, thread.get("leafId").and_then(Value::as_str), &mut out);
    out
}

fn visit_btw_node(node: &Value, id: &str, topic_id: &str, leaf_id: Option<&str>, out: &mut Vec<Value>) {
    let mut record = json!({
        "id": id,
        "topicId": topic_id,
        "status": node.get("status").cloned().unwrap_or(Value::Null),
        "question": node.get("question").cloned().unwrap_or(Value::Null),
        "answer": node.get("answer").cloned().unwrap_or(Value::Null),
        "createdAt": node.get("createdAt").cloned().unwrap_or(Value::Null),
        "updatedAt": node.get("updatedAt").cloned().unwrap_or(Value::Null),
    });
    // TS `?:` optional fields are omitted entirely when absent, not sent as JSON `null` (same
    // convention `agent::mod`'s own `status_event_locked` documents).
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

/// Gate-fix (round 4, Code4/Verif4 CRITICAL): a live `btw`/`btw_record` response is the SAME
/// whole-tree shape `get_btw_history` returns per topic -- a follow-up's own response still
/// carries the ROOT's `question`/`answer`/`status`, with the new turn nested at `followUps`'s
/// last entry. Reuses `flatten_btw_history` (same ids, same `topicId`) and returns its LAST
/// entry -- the actual latest turn OMP's response/push describes, never the stale root row `ask`/
/// `on_frame` would otherwise silently re-patch forever.
fn latest_turn(thread: &Value) -> Value {
    let mut flattened = flatten_btw_history(thread);
    // `flatten_btw_history` always visits the root first, so `flattened` is never empty.
    flattened.pop().unwrap_or(Value::Null)
}

// ---------------------------------------------------------------------------
// Epoch / visibility gates (pure, testable independently of a live `SessionAgent`)
// ---------------------------------------------------------------------------

/// Gate-fix (round 6, Code6/Sec6/A11y6/Verif6 HIGH, defense in depth; round 7, Code7/Verif7
/// Medium): whether a `btw_delta`/`btw_record` frame for a topic stamped with `topic_epoch` (or
/// the CURRENT conversation epoch when the topic was never stamped by `ask` at all -- loaded
/// from history, never asked through this process instance, which must NOT be treated as stale)
/// must be dropped rather than forwarded, because a Conversation switch landed after the topic
/// was stamped. `ask` always captures its own epoch BEFORE sending the request (never re-reads
/// `conversation_epoch` once the response arrives), so a switch that lands while the request is
/// still in flight stamps the topic with the OLD epoch, which this correctly treats as stale once
/// the switch's own epoch bump has happened.
fn topic_frame_is_stale(topic_epoch: u64, conversation_epoch: u64) -> bool {
    topic_epoch < conversation_epoch
}

/// Gate-fix (round 9, Code9/Sec9/A11y9/Verif9 Medium; wording corrected round 10): whether a
/// topic's own entry in `sideChatTopicEpoch` must be deleted once this turn is the topic's latest
/// -- bounded by SETTLEDNESS (a non-"running" status), never by age.
fn turn_reached_terminal(status: &str) -> bool {
    status != "running"
}

/// Gate-fix (round 2, Verif2 LOW / round 4, Code4 Medium): whether a `side-chat:patch` payload is
/// forwarded given this Session's current visibility. A terminal `btw_record` and a `btw-history`
/// notice are ALWAYS forwarded, regardless of visibility -- losing a side chat's own completion,
/// or a save-failure notice, to the visibility gate leaves the panel stuck (or silently wrong)
/// until a reload; only a `btw_delta` (no `record`, no `notice`) stays gated on visibility, like
/// every other live-stream patch.
fn should_forward_side_chat_patch(has_record_or_notice: bool, is_visible: bool) -> bool {
    has_record_or_notice || is_visible
}

// ---------------------------------------------------------------------------
// Lane extension points
// ---------------------------------------------------------------------------

pub(super) async fn on_frame(agent: &SessionAgent, frame_type: &str, frame: &Value) {
    match frame_type {
        "notice" => {
            // Gate-fix (round 4, Code4 Medium, constitution II/FR-010): a `btw-history` save
            // failure arrives as an ordinary `notice` frame -- `frame.rs`'s own main match
            // already skips it for the main transcript (see that file's header); routed to the
            // side-chat store as a toast instead, same as every other side-chat failure.
            if frame.get("source").and_then(Value::as_str) != Some("btw-history") {
                return;
            }
            let Some(message) = frame.get("message").and_then(Value::as_str) else {
                return;
            };
            if should_forward_side_chat_patch(true, agent.is_visible()) {
                agent
                    .events()
                    .emit_side_chat_patch_notice(agent.session_id(), message);
            }
        }
        "btw_delta" => {
            let Some(record_id) = frame.get("recordId").and_then(Value::as_str) else {
                return;
            };
            let Some(delta) = frame.get("delta").and_then(Value::as_str) else {
                return;
            };
            let (topic_epoch, conversation_epoch) = agent
                .with_side_chat_state(|s| {
                    (
                        s.topic_epoch.get(record_id).copied().unwrap_or(s.conversation_epoch),
                        s.conversation_epoch,
                    )
                })
                .await;
            if topic_frame_is_stale(topic_epoch, conversation_epoch) {
                return;
            }
            if should_forward_side_chat_patch(false, agent.is_visible()) {
                agent
                    .events()
                    .emit_side_chat_patch_delta(agent.session_id(), delta, record_id);
            }
        }
        "btw_record" => {
            let Some(record) = frame.get("record") else {
                return;
            };
            let Some(topic_id) = record.get("id").and_then(Value::as_str).map(str::to_string) else {
                return;
            };
            let (topic_epoch, conversation_epoch) = agent
                .with_side_chat_state(|s| {
                    (
                        s.topic_epoch.get(&topic_id).copied().unwrap_or(s.conversation_epoch),
                        s.conversation_epoch,
                    )
                })
                .await;
            let stale = topic_frame_is_stale(topic_epoch, conversation_epoch);
            let turn = latest_turn(record);
            let status = turn.get("status").and_then(Value::as_str).unwrap_or("");
            if turn_reached_terminal(status) {
                agent
                    .with_side_chat_state(|s| {
                        s.topic_epoch.remove(&topic_id);
                    })
                    .await;
            }
            if stale {
                return;
            }
            if should_forward_side_chat_patch(true, agent.is_visible()) {
                agent
                    .events()
                    .emit_side_chat_patch_record(agent.session_id(), &turn);
            }
        }
        _ => {}
    }
}

/// Port of `SessionAgent.ts`'s own `onExit`: fired unconditionally, before any other exit
/// handling (see `SessionAgentEvents.sideChatInterrupted`'s own doc comment for exactly which
/// exit path this closes) -- a side-chat record left `running` must never block Send/Retry/`/btw`
/// forever once a NEW process starts. `topic_epoch` is cleared unconditionally too: a brand-new
/// process for this Session always starts a brand-new history store, so nothing this map could
/// still protect survives a restart.
pub(super) async fn on_exit(agent: &SessionAgent, _code: Option<i32>, _requested: bool) {
    agent
        .with_side_chat_state(|s| {
            s.topic_epoch.clear();
        })
        .await;
    agent.events().emit_side_chat_interrupted(agent.session_id());
}

pub(super) async fn on_start_progress(
    _agent: &SessionAgent,
    _stage: ReadyWaitStage,
    _elapsed_ms: u64,
) {
    // No side-chat behaviour ties to the ready-wait banner (port of `SessionAgent.ts`, which has
    // none either).
}

/// Port of `SessionAgent.ts`'s own `notifySideChatConversationChanged`: the one place that bumps
/// `conversation_epoch` and fires `side-chat:conversation-changed`, called from
/// `session::agent::conversations`' `start_new_conversation` (unconditionally) and
/// `open_conversation` (only when the Conversation actually changed) -- same call sites TS's own
/// `startNewConversation`/`openConversation` use.
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

// ---------------------------------------------------------------------------
// `sideChat.*` / `chat.predictWord*` (called from `ipc::side_chat`)
// ---------------------------------------------------------------------------

/// `sideChat.ask` (contracts/ipc.md "Side chat"): issues `btw`, returning the new (`running`)
/// record's own whole shape immediately -- the answer itself arrives over `side-chat:patch` as a
/// terminal `btw_record` (`on_frame`'s own case above), never this call's return value.
/// `record_id` omitted starts a fresh topic (FR-003); given, continues one. Gate-fix (round 7,
/// Code7/Verif7 Medium): `epoch` is captured BEFORE the request, not after it resolves -- see
/// `topic_frame_is_stale`'s own doc comment for why.
pub async fn ask(
    agent: &SessionAgent,
    question: String,
    record_id: Option<String>,
) -> Result<Value, AgentError> {
    let epoch = agent.with_side_chat_state(|s| s.conversation_epoch).await;
    if let Some(record_id) = &record_id {
        agent
            .with_side_chat_state(|s| {
                s.topic_epoch.insert(record_id.clone(), epoch);
            })
            .await;
    }
    let mut cmd = json!({ "type": "btw", "question": question });
    if let Some(record_id) = &record_id {
        cmd["recordId"] = Value::String(record_id.clone());
    }
    let res = agent.request_rpc(cmd, REQUEST_TIMEOUT_MS).await?;
    if res.get("success").and_then(Value::as_bool) != Some(true) {
        let message = res
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("unknown error");
        return Err(AgentError::new(
            "prompt-failed",
            format!("btw failed: {message}"),
        ));
    }
    let Some(thread) = res.get("data").and_then(|d| d.get("record")) else {
        return Err(AgentError::new(
            "prompt-failed",
            "btw succeeded but returned no record",
        ));
    };
    // Gate-fix (round 6, Code6/Sec6/A11y6/Verif6 HIGH defense in depth): stamps the TOPIC's own
    // root id (never the latest turn's own flattened id) with the epoch captured above.
    let thread_id = thread.get("id").and_then(Value::as_str).unwrap_or("").to_string();
    agent
        .with_side_chat_state(|s| {
            s.topic_epoch.insert(thread_id, epoch);
        })
        .await;
    Ok(json!({ "record": latest_turn(thread) }))
}

/// `sideChat.cancel` (contracts/ipc.md): issues `btw_cancel` for this Session's currently-running
/// side question, if any -- a no-op (not an error) if nothing is running, mirroring
/// `subagents.cancel`'s own idempotent shape. The cancelled record itself arrives over
/// `side-chat:patch` as an ordinary `btw_record` with `status: "cancelled"` (FR-006).
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

/// `sideChat.getHistory` (contracts/ipc.md, FR-004): every side-chat record OMP has for this
/// Session's saved session file, flattened from `get_btw_history`'s own nested per-topic shape.
/// Gate-fix (round 4, Code4/Verif4 HIGH): OMP's own `get_btw_history` returns topics NEWEST
/// first -- sorted ascending by `createdAt` here so the flattened result reads oldest-to-newest.
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
    let mut threads: Vec<Value> = res
        .get("data")
        .and_then(|d| d.get("records"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    threads.sort_by(|a, b| {
        let a = a.get("createdAt").and_then(Value::as_f64).unwrap_or(0.0);
        let b = b.get("createdAt").and_then(Value::as_f64).unwrap_or(0.0);
        a.total_cmp(&b)
    });
    Ok(threads.iter().flat_map(flatten_btw_history).collect())
}

/// `chat.predictWord` (FR-058): ghost-text composer completion. Issues `predict_word` ONLY on an
/// already-running live process -- `request_rpc` never starts one -- since the first call after a
/// cold shared prediction daemon start can take up to ~150 s (`rpc.md`, FINDINGS item 28), and a
/// keystroke in a stopped Session's composer must never trigger that. Best-effort: any failure
/// (no live process, a timeout, an RPC-level error, a malformed response) degrades to `None`,
/// never surfaced as an error -- the off switch (#772) is checked by the IPC caller before this
/// is ever reached.
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

/// `chat.predictWordFeedback`: companion to `predict_word` above, same silent-degradation
/// contract -- no live process or a failed send is dropped, never surfaced.
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
