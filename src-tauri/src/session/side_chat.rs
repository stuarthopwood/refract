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
    /// SETTLEDNESS, not by age -- `apply_frame`'s own `btw_record` case deletes an entry (moving
    /// it to `terminal_topic_epoch` below) once that topic's LATEST TURN reaches a terminal
    /// status; `on_exit` clears the whole map unconditionally on every process exit.
    topic_epoch: std::collections::HashMap<String, u64>,
    /// Gate-fix (2026-10-14 gate review round 2 HIGH, a REAL cross-Conversation leak; Electron
    /// has the identical hole, issue #789's own "port the fixed behaviour" note filed against it):
    /// a terminal/cancelled topic's `topic_epoch` entry above is removed to bound memory, but a
    /// late frame for that SAME `record_id` arriving after a Conversation switch must still be
    /// recognised as belonging to the OLD Conversation -- `unwrap_or(conversation_epoch)` alone
    /// cannot tell "never asked this session" (correctly never stale) from "asked, went terminal,
    /// entry removed" (must stay stale forever after a switch) once both cases return the same
    /// "not found" lookup. This tombstone keeps the epoch a now-terminal topic belonged to;
    /// `apply_frame` checks it as a second fallback before `conversation_epoch`.
    /// `on_conversation_reset` retains only the CURRENT generation's tombstones (the ones that
    /// still need protecting against a frame straggling in from the Conversation just left) and
    /// drops anything older, so this stays bounded across a long session; `on_exit` clears it.
    terminal_topic_epoch: std::collections::HashMap<String, u64>,
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

/// Resolves the epoch a topic belongs to for a staleness check: the ACTIVE `topic_epoch` entry
/// if the topic is still running; else its tombstoned `terminal_topic_epoch` entry if it already
/// went terminal (gate-fix round 2 HIGH: without this fallback, a late frame for an
/// already-terminal topic falls through to `conversation_epoch` itself and is wrongly treated as
/// current/never-stale); else `conversation_epoch` (a topic never stamped this process instance
/// at all -- loaded from history -- which must NOT be treated as stale).
fn resolve_topic_epoch(state: &State, topic_id: &str) -> u64 {
    state
        .topic_epoch
        .get(topic_id)
        .or_else(|| state.terminal_topic_epoch.get(topic_id))
        .copied()
        .unwrap_or(state.conversation_epoch)
}

/// What `on_frame` must forward to the renderer as a `side-chat:patch`, if anything -- the
/// decision `apply_frame` below makes.
#[derive(Debug, PartialEq)]
pub(super) enum SideChatPatch {
    Delta { delta: String, record_id: String },
    Record { record: Value },
    Notice { message: String },
}

/// Pure core of `on_frame`'s three live-wire cases (gate-fix, 2026-10-14 gate review: these rules
/// used to be proven only against a hand-built `State` and the isolated predicates above, which
/// cannot fail for a regression in how `on_frame` itself reads or mutates the REAL state across a
/// real sequence of calls -- this factors out that exact logic so a test can drive it). Mutates
/// `state` precisely as the live path does (epoch lookups, terminal-status deletion); returns
/// what SHOULD be forwarded, or `None` if this frame is dropped (stale, visibility-gated, or
/// simply not a recognised case).
pub(super) fn apply_frame(
    state: &mut State,
    frame_type: &str,
    frame: &Value,
    is_visible: bool,
) -> Option<SideChatPatch> {
    match frame_type {
        "notice" => {
            // Gate-fix (round 4, Code4 Medium, constitution II/FR-010): a `btw-history` save
            // failure arrives as an ordinary `notice` frame -- `frame.rs`'s own main match
            // already skips it for the main transcript (see that file's header); routed to the
            // side-chat store as a toast instead, same as every other side-chat failure.
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
                state.topic_epoch.remove(&topic_id);
                state.terminal_topic_epoch.insert(topic_id, topic_epoch);
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

// ---------------------------------------------------------------------------
// Lane extension points
// ---------------------------------------------------------------------------

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

/// Port of `SessionAgent.ts`'s own `onExit`: fired unconditionally, before any other exit
/// handling (see `SessionAgentEvents.sideChatInterrupted`'s own doc comment for exactly which
/// exit path this closes) -- a side-chat record left `running` must never block Send/Retry/`/btw`
/// forever once a NEW process starts. Both maps are cleared unconditionally too: a brand-new
/// process for this Session always starts a brand-new history store, so nothing stamped or
/// tombstoned here survives into it.
pub(super) async fn on_exit(agent: &SessionAgent, _code: Option<i32>, _requested: bool) {
    agent
        .with_side_chat_state(|s| {
            s.topic_epoch.clear();
            s.terminal_topic_epoch.clear();
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
    // No side-chat behaviour ties to the ready-wait banner (port of `SessionAgent.ts`, which has
    // none either).
}

/// Port of `SessionAgent.ts`'s own `notifySideChatConversationChanged`: the one place that bumps
/// `conversation_epoch` and fires `side-chat:conversation-changed`, called from
/// `session::agent::conversations`' `start_new_conversation` (unconditionally) and
/// `open_conversation` (only when the Conversation actually changed), and from
/// `session::agent::launch`'s `start_with_conversation` via `reset_after_start_with_conversation`
/// below (only when the Conversation actually changed) -- same call sites TS's own
/// `startNewConversation`/`openConversation`/`startStoppedSessionOnConversation` use. Gate-fix
/// (2026-10-14 gate review round 2 HIGH): before bumping the epoch, retains only
/// `terminal_topic_epoch` tombstones from the generation JUST ENDING (the ones that still need
/// to catch a straggling frame from the Conversation this call is leaving) and drops anything
/// older -- so the tombstone map never grows past one generation's worth of now-terminal topics.
pub(super) async fn on_conversation_reset(agent: &SessionAgent) {
    agent
        .with_side_chat_state(|s| {
            let retiring_epoch = s.conversation_epoch;
            s.terminal_topic_epoch
                .retain(|_, epoch| *epoch == retiring_epoch);
            s.conversation_epoch = s.conversation_epoch.wrapping_add(1);
        })
        .await;
    agent
        .events()
        .emit_side_chat_conversation_changed(agent.session_id());
}

/// Port of `conversationSwitch.ts`'s own gate-fix (round 6 HIGH; 2026-10-14 gate review found
/// `start_with_conversation` never called this at all): the ONLY Conversation-switch path
/// available while `status == Stopped` -- without it a stopped Session kept the previous
/// Conversation's side-chat rows/epoch, so the next question's topic id was rejected with
/// "Unknown /btw topic" (the defect `open_conversation`'s own guard already fixed for a LIVE
/// Session). Called right AFTER the registry write succeeds and BEFORE `launch()` runs (round 2
/// gate-fix: matches `conversationSwitch.ts`'s own `prepare` callback ordering), so it fires even
/// if the subsequent start itself fails. `previous_conversation` is `None` when
/// `start_with_conversation` never wrote the registry at all (worktree missing); `Some(None)`
/// means it wrote but there was no earlier Conversation. Skipped when `file` IS
/// `previous_conversation` (reopening the same Conversation, its topics are still valid); always
/// resets for `file: None` (a brand-new Conversation), matching `start_new_conversation`'s own
/// unconditional reset.
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

// ---------------------------------------------------------------------------
// `sideChat.*` / `chat.predictWord*` (called from `ipc::side_chat`)
// ---------------------------------------------------------------------------

/// `ask`'s own pre-request stamp (gate-fix round 7, Code7/Verif7 Medium, "stamping order"):
/// captures `conversation_epoch` BEFORE the request is sent and, for a continuation, stamps the
/// topic with that value immediately -- never re-read after the response resolves, so a
/// Conversation switch landing while the request is still in flight correctly leaves the topic
/// stamped with the OLD epoch (`topic_frame_is_stale`'s own doc comment explains why that
/// matters). Factored out of `ask` so a test can drive the exact "stamp, then a switch lands,
/// then a late frame arrives" sequence against a real `State`.
fn stamp_continuation_before_ask(state: &mut State, record_id: Option<&str>) -> u64 {
    let epoch = state.conversation_epoch;
    if let Some(record_id) = record_id {
        state.topic_epoch.insert(record_id.to_string(), epoch);
    }
    epoch
}

/// `ask`'s own post-response stamp (gate-fix round 6, Code6/Sec6/A11y6/Verif6 HIGH defense in
/// depth): stamps the TOPIC's own root id (never the latest turn's own flattened id) with the
/// epoch `stamp_continuation_before_ask` captured BEFORE the request was sent -- never a value
/// re-read after the response resolves. Factored out of `ask` (not inlined) so a test can drive a
/// REAL `on_conversation_reset` bump between the capture and this stamp, reproducing the exact
/// race the epoch guard protects against.
fn stamp_topic_after_response(state: &mut State, thread_id: String, epoch: u64) {
    state.topic_epoch.insert(thread_id, epoch);
}

/// `sideChat.ask` (contracts/ipc.md "Side chat"): issues `btw`, returning the new (`running`)
/// record's own whole shape immediately -- the answer itself arrives over `side-chat:patch` as a
/// terminal `btw_record` (`on_frame`'s own case above), never this call's return value.
/// `record_id` omitted starts a fresh topic (FR-003); given, continues one.
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

/// Gate-fix (2026-10-14 gate review MEDIUM; round 2 tightened to compare-and-remove): `ask`'s own
/// pre-insert of `record_id`'s epoch above (continuing an existing topic) must not leak a dead
/// entry into `topic_epoch` forever when the `btw` request then fails -- nothing else cleans up a
/// continuation's entry for a topic that never got a terminal `btw_record` frame to trigger
/// `apply_frame`'s own settledness-bounded delete. Removes the entry ONLY if it still holds the
/// exact epoch THIS `ask` call stamped -- a later, successful `ask` for the same `record_id`
/// (racing in before this failed call's own cleanup runs) must never have ITS entry wiped by an
/// earlier call's own failure.
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
    let threads: Vec<Value> = res
        .get("data")
        .and_then(|d| d.get("records"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Ok(sort_and_flatten_threads(threads))
}

/// Pure core of `history`'s own post-RPC shaping (gate-fix round 4, Code4/Verif4 HIGH): OMP's own
/// `get_btw_history` returns topics NEWEST first -- sorted ascending by `createdAt` here so the
/// flattened result reads oldest-to-newest. Factored out so a test can assert the ordering
/// without a live RPC round trip.
fn sort_and_flatten_threads(mut threads: Vec<Value>) -> Vec<Value> {
    threads.sort_by(|a, b| {
        let a = a.get("createdAt").and_then(Value::as_f64).unwrap_or(0.0);
        let b = b.get("createdAt").and_then(Value::as_f64).unwrap_or(0.0);
        a.total_cmp(&b)
    });
    threads.iter().flat_map(flatten_btw_history).collect()
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
