// Readout pills and the live checked-out branch; hooks are called from `session::agent`.

use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use crate::git::diff_stat::diff_stat;
use crate::git::git::git_raw;
use crate::omp::process::ReadyWaitStage;

use super::agent::SessionAgent;
use crate::fs::worktree_access::read_guard_bounded;

#[path = "readout_pr.rs"]
mod readout_pr;
use readout_pr::{
    pull_request_for_branch, pull_request_for_link, PullRequestLookup, PullRequestState,
};

#[path = "readout_touched.rs"]
mod readout_touched;

#[path = "readout_todo.rs"]
mod readout_todo;
use readout_todo::{build_todo_tree, compute_up_next, parse_todo_phases, TodoPhaseState};
#[path = "readout_activity.rs"]
mod readout_activity;
pub use readout_activity::current_activity;
use readout_activity::ActivityState;

/// Readout pushes are at most one per this interval per Session.
const READOUT_COALESCE_MS: u64 = 100;
const GIT_READ_TIMEOUT: Duration = Duration::from_secs(3);
/// Interval between background pull-request lookups.
const PR_POLL_INTERVAL_MS: u64 = 60_000;

#[derive(Debug, Clone)]
struct ContextUsageState {
    used_tokens: i64,
    window_tokens: i64,
    percent: f64,
}

/// Readout runtime state, held inside `AgentState`.
#[derive(Default)]
pub(super) struct State {
    turn_started_at: Option<i64>,
    context_usage: Option<ContextUsageState>,
    ai_credits: Option<f64>,
    /// True once a `get_state` has synced this run.
    state_synced: bool,
    todo_phases: Option<Vec<TodoPhaseState>>,
    pull_request: Option<PullRequestState>,
    /// Branch the PR lookup last ran for; `None` forces the first lookup.
    pull_request_branch: Option<String>,
    timer_pending: bool,
    in_flight: bool,
    pending: bool,
    /// Last assembled readout, so snapshots return the live value; `None` until first computed.
    last_readout: Option<Value>,
    /// Bumped on launch and exit; a stale PR-poll loop sees the mismatch and returns.
    pr_poll_generation: u64,
    /// Latest intent, tool, retry and compaction state for the current-work banner.
    activity: ActivityState,
    /// PRs and issues this Conversation wrote to through `gh`.
    touched: readout_touched::TouchedState,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Random 0..`cap_ms` delay so Sessions launched together don't poll in lockstep.
fn jitter_ms(cap_ms: u64) -> u64 {
    if cap_ms == 0 {
        return 0;
    }
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| (d.subsec_nanos() as u64) % cap_ms)
        .unwrap_or(0)
}

pub(super) async fn on_frame(agent: &SessionAgent, frame_type: &str, frame: &Value) {
    readout_touched::on_frame(agent, frame_type, frame).await;
    readout_activity::on_frame(agent, frame_type, frame).await;
    match frame_type {
        "agent_start" => {
            let started_at = now_ms();
            agent
                .with_readout_state(|s| s.turn_started_at = Some(started_at))
                .await;
            schedule_readout_update(agent).await;
        }
        "session_settled" => {
            agent.with_readout_state(|s| s.turn_started_at = None).await;
            schedule_readout_update(agent).await;
        }
        "prompt_result" => {
            if frame.get("sessionSettled").and_then(Value::as_bool) == Some(true) {
                agent.with_readout_state(|s| s.turn_started_at = None).await;
            }
            schedule_readout_update(agent).await;
        }
        "tool_execution_start" => {
            // Any non-task tool call may change `changes`.
            if frame.get("toolName").and_then(Value::as_str) != Some("task") {
                schedule_readout_update(agent).await;
            }
        }
        "tool_execution_end" => {
            // The `todo` call-end frame carries the full phases tree; a malformed one keeps the old tree.
            if frame.get("toolName").and_then(Value::as_str) == Some("todo") {
                if let Some(phases) = frame
                    .get("result")
                    .and_then(|r| r.get("details"))
                    .and_then(|d| d.get("phases"))
                    .and_then(parse_todo_phases)
                {
                    agent
                        .with_readout_state(|s| s.todo_phases = Some(phases))
                        .await;
                }
            }
            schedule_readout_update(agent).await;
        }
        _ => {}
    }
}

pub(super) async fn on_exit(agent: &SessionAgent, _code: Option<i32>, _requested: bool) {
    super::readout_head_watch::stop(agent.session_id());
    // A process that exited mid-turn sends no settle frame, so clear the turn-running reading here.
    let had_turn = agent
        .with_readout_state(|s| {
            let had = s.turn_started_at.is_some() | s.activity.reset();
            s.turn_started_at = None;
            s.pr_poll_generation = s.pr_poll_generation.wrapping_add(1);
            had
        })
        .await;
    if had_turn {
        schedule_readout_update(agent).await;
    }
}

pub(super) async fn on_start_progress(
    _agent: &SessionAgent,
    _stage: ReadyWaitStage,
    _elapsed_ms: u64,
) {
    // No-op: the start-progress banner belongs to `session::start_queue`.
}

/// Called once per launch; starts a poll loop that stops when `on_exit` bumps the generation.
pub(super) async fn on_launch(agent: &SessionAgent) {
    let generation = agent
        .with_readout_state(|s| {
            s.pr_poll_generation = s.pr_poll_generation.wrapping_add(1);
            s.pr_poll_generation
        })
        .await;
    let agent = agent.arc();
    tokio::spawn(async move {
        let mut first = true;
        loop {
            let Some(session) = agent
                .registry()
                .lock()
                .await
                .get_session(agent.session_id())
                .cloned()
            else {
                return;
            };
            if first {
                // Seed the branch first so this lookup isn't discarded as stale.
                agent
                    .with_readout_state(|s| s.pull_request_branch = Some(session.branch.clone()))
                    .await;
                super::readout_head_watch::start(&agent, &session.worktree_path).await;
            }
            refresh_pull_request(&agent, &session.worktree_path, &session.branch).await;
            schedule_readout_update(&agent).await;
            // Jitter only the first sleep.
            let sleep_ms = if first {
                jitter_ms(PR_POLL_INTERVAL_MS)
            } else {
                PR_POLL_INTERVAL_MS
            };
            first = false;
            tokio::time::sleep(Duration::from_millis(sleep_ms)).await;
            let still_current = agent
                .with_readout_state(|s| s.pr_poll_generation == generation)
                .await;
            if !still_current {
                return;
            }
        }
    });
}

/// Refreshes context usage and todo progress from the `get_state` response.
pub(super) async fn on_sync_from_state(agent: &SessionAgent, state: &Value) {
    let context_usage = state.get("contextUsage").and_then(parse_context_usage);
    let todo_phases = state.get("todoPhases").and_then(parse_todo_phases);
    agent
        .with_readout_state(|s| {
            s.state_synced = true;
            s.context_usage = context_usage;
            s.todo_phases = todo_phases;
        })
        .await;
    schedule_readout_update(agent).await;
    if let Some(credits) = super::ai_credits::fetch_ai_credits(agent, state).await {
        agent.with_readout_state(|s| s.ai_credits = credits).await;
        schedule_readout_update(agent).await;
    }
}

/// Clears per-Conversation readings before the next sync, so the old Conversation's values never show.
pub(super) async fn on_conversation_reset(agent: &SessionAgent) {
    agent
        .with_readout_state(|s| {
            s.state_synced = false;
            s.context_usage = None;
            s.ai_credits = None;
            s.todo_phases = None;
            s.activity.reset();
            s.touched.reset();
        })
        .await;
    schedule_readout_update(agent).await;
}

/// Rebuilds the touched list from the loaded Conversation history.
pub(super) async fn on_history_loaded(agent: &SessionAgent, history: &[Value]) {
    readout_touched::rebuild_from_history(agent, history).await;
    schedule_readout_update(agent).await;
}

/// Last assembled readout, or the empty shape before the first compute.
pub async fn current_readout_value(agent: &SessionAgent) -> Value {
    agent
        .with_readout_state(|s| s.last_readout.clone())
        .await
        .unwrap_or_else(empty_readout)
}

/// Where a Session's PR value comes from: the readout the agent already holds, else a lookup.
#[derive(Debug, PartialEq)]
enum PrSource {
    Cached(Value),
    Lookup,
}

fn pr_source(cached: Value) -> PrSource {
    if cached.is_null() {
        PrSource::Lookup
    } else {
        PrSource::Cached(cached)
    }
}

/// Only the number and the url leave the readout; anything else reads as no PR.
fn link_of(pr: &Value) -> Value {
    match (pr.get("number"), pr.get("url")) {
        (Some(number), Some(url)) => json!({ "number": number, "url": url }),
        _ => Value::Null,
    }
}

/// `{ number, url }` of the Session's PR for the Session tools (#1858): the readout cache when the
/// agent already has one, else one backed-off lookup. `Null` for no PR or an unavailable lookup.
pub async fn pull_request_link(
    agent: Option<&SessionAgent>,
    session_id: &str,
    worktree_path: &str,
    branch: &str,
) -> Value {
    let cached = match agent {
        Some(agent) => current_readout_value(agent).await["pullRequest"].clone(),
        None => Value::Null,
    };
    let pr = match pr_source(cached) {
        PrSource::Cached(pr) => pr,
        PrSource::Lookup => pull_request_for_link(session_id, Path::new(worktree_path), branch)
            .await
            .into_json(),
    };
    link_of(&pr)
}

fn empty_readout() -> Value {
    let mut readout = json!({
        "changes": Value::Null,
        "contextUsage": Value::Null,
        "turnTime": Value::Null,
        "pullRequest": Value::Null,
        "subagentCount": Value::Null,
        "todoTree": Value::Null,
        "todoPhases": Value::Null,
        "branch": Value::Null,
    });
    ActivityState::default().write_into(&mut readout);
    readout
}

fn parse_context_usage(value: &Value) -> Option<ContextUsageState> {
    Some(ContextUsageState {
        used_tokens: value.get("tokens").and_then(Value::as_i64)?,
        window_tokens: value.get("contextWindow").and_then(Value::as_i64)?,
        percent: value.get("percent").and_then(Value::as_f64)?,
    })
}

/// Debounced and single-flight; `pub(crate)` so git and fs watchers can trigger it.
/// Returns a boxed future, not `async fn`, to break a recursive opaque-type cycle (E0391).
pub(crate) fn schedule_readout_update(
    agent: &SessionAgent,
) -> Pin<Box<dyn Future<Output = ()> + Send + 'static>> {
    let agent = agent.arc();
    Box::pin(async move {
        readout_activity::emit_activity(&agent).await;
        let should_spawn = agent
            .with_readout_state(|s| {
                if s.timer_pending {
                    false
                } else {
                    s.timer_pending = true;
                    true
                }
            })
            .await;
        if !should_spawn {
            return;
        }
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(READOUT_COALESCE_MS)).await;
            agent.with_readout_state(|s| s.timer_pending = false).await;
            run_readout_update(&agent).await;
        });
    })
}

/// A rerun goes back through the debounce, so emissions stay at least `READOUT_COALESCE_MS` apart.
async fn run_readout_update(agent: &Arc<SessionAgent>) {
    let should_run = agent
        .with_readout_state(|s| {
            if s.in_flight {
                s.pending = true;
                false
            } else {
                s.in_flight = true;
                true
            }
        })
        .await;
    if !should_run {
        return;
    }
    compute_readout(agent).await;
    let rerun = agent
        .with_readout_state(|s| {
            s.in_flight = false;
            if s.pending {
                s.pending = false;
                true
            } else {
                false
            }
        })
        .await;
    if rerun {
        schedule_readout_update(agent).await;
    }
}

/// Computes the readout. A branch change triggers a PR lookup, spawned so `gh` never blocks this run.
async fn compute_readout(agent: &Arc<SessionAgent>) {
    let Some(session) = agent
        .registry()
        .lock()
        .await
        .get_session(agent.session_id())
        .cloned()
    else {
        return;
    };

    let branch_changed = agent
        .with_readout_state(|s| {
            if s.pull_request_branch.as_deref() != Some(session.branch.as_str()) {
                s.pull_request_branch = Some(session.branch.clone());
                true
            } else {
                false
            }
        })
        .await;
    if branch_changed {
        let spawned = agent.clone();
        let worktree_path = session.worktree_path.clone();
        let branch = session.branch.clone();
        tokio::spawn(async move {
            refresh_pull_request(&spawned, &worktree_path, &branch).await;
            schedule_readout_update(&spawned).await;
        });
    }

    readout_touched::refresh(agent, &session.worktree_path).await;
    // Independent reads, so run them concurrently.
    let (diff_result, branch) = tokio::join!(
        async {
            // One guard per read: `join!` branches must not share or nest a guard (#1157).
            let _guard = read_guard_bounded(agent.session_id()).await.ok()?;
            diff_stat(Path::new(&session.worktree_path), &session.base_branch).await
        },
        compute_branch(agent.session_id(), &session.worktree_path)
    );
    let changes = match diff_result {
        Some(stat) => {
            serde_json::to_value(stat).expect("DiffStatResult is always JSON-serialisable")
        }
        None => Value::String("not-available".to_string()),
    };
    let subagent_count = super::subagents::subagent_count(agent).await;

    let readout = agent
        .with_readout_state(|s| {
            let value = build_readout_value(s, changes, branch, subagent_count);
            s.last_readout = Some(value.clone());
            value
        })
        .await;
    // Hidden Sessions get no readout update.
    if agent.is_visible() {
        agent
            .events()
            .emit_readout_update(agent.session_id(), readout);
    }
}

/// Looks up the PR for the branch; drops the result if the branch changed meanwhile.
async fn refresh_pull_request(agent: &SessionAgent, worktree_path: &str, branch: &str) {
    let lookup =
        pull_request_for_branch(agent.session_id(), Path::new(worktree_path), branch).await;
    let still_current = agent
        .with_readout_state(|s| s.pull_request_branch.as_deref() == Some(branch))
        .await;
    if !still_current {
        return;
    }
    agent
        .with_readout_state(|s| {
            s.pull_request = match lookup {
                PullRequestLookup::Found(pr) => Some(pr),
                PullRequestLookup::None => None,
                // Indeterminate lookups keep the previous reading so the chip doesn't flicker.
                PullRequestLookup::Unavailable => s.pull_request.clone(),
            };
        })
        .await;
}

/// Live checked-out branch, or the short HEAD when detached; null when unreadable (not retained).
pub(super) async fn compute_branch(session_id: &str, worktree_path: &str) -> Value {
    let path = Path::new(worktree_path);
    let Ok(guard) = read_guard_bounded(session_id).await else {
        return Value::Null;
    };
    let symbolic = git_raw(
        path,
        &["symbolic-ref", "--short", "-q", "HEAD"],
        Some(GIT_READ_TIMEOUT),
    )
    .await;
    drop(guard);
    if symbolic.code == 0 {
        let name = symbolic.stdout.trim();
        if !name.is_empty() {
            return json!({ "name": name, "detached": false });
        }
    }
    let Ok(_guard) = read_guard_bounded(session_id).await else {
        return Value::Null;
    };
    let rev = git_raw(
        path,
        &["rev-parse", "--short", "HEAD"],
        Some(GIT_READ_TIMEOUT),
    )
    .await;
    if rev.code == 0 {
        let sha = rev.stdout.trim();
        if !sha.is_empty() {
            return json!({ "name": sha, "detached": true });
        }
    }
    Value::Null
}

fn build_readout_value(
    s: &State,
    changes: Value,
    branch: Value,
    subagent_count: Option<Value>,
) -> Value {
    let context_usage = match &s.context_usage {
        Some(c) => json!({
            "usedTokens": c.used_tokens,
            "windowTokens": c.window_tokens,
            "percent": c.percent,
        }),
        None if s.state_synced => Value::String("not-available".to_string()),
        None => Value::Null,
    };
    // Full retained tree; done/total counting happens in the frontend derive, not here.
    let todo_tree = build_todo_tree(s.todo_phases.as_ref());
    // Pending todo phases for "Up next"; null when none remain.
    let todo_phases_up_next = compute_up_next(s.todo_phases.as_ref());
    let turn_time = s
        .turn_started_at
        .map(|started_at| json!({ "startedAt": started_at }));
    let pull_request = s.pull_request.as_ref().map(PullRequestState::to_json);
    let mut readout = json!({
        "changes": changes,
        "contextUsage": context_usage,
        "aiCredits": s.ai_credits,
        "turnTime": turn_time,
        "pullRequest": pull_request,
        "subagentCount": subagent_count,
        "todoTree": todo_tree,
        "todoPhases": todo_phases_up_next,
        "branch": branch,
    });
    if let Some(touched) = s.touched.json() {
        readout["touched"] = touched;
    }
    s.activity.write_into(&mut readout);
    readout
}

#[cfg(test)]
#[path = "readout.test.rs"]
mod tests;
