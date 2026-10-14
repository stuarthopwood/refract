// Readout pills (spec 004: context/token usage, changes, turn time, pull request, subagents,
// todo progress), the live checked-out branch (#724), and the readout half of the memory-warning
// lane (lane R5, issue #788). Pre-declared so lane R5 is the only lane that ever edits this file
// (issue #784, "Pre-declare per-lane Rust files").
//
// Port of `src/main/omp/readout.ts`'s own `assembleReadout` plus the readout-assembly half of
// `SessionAgent.ts` (`computeReadout`/`scheduleReadoutUpdate`/`runReadoutUpdate`/
// `refreshPullRequest`/`syncFromState`'s own `lastContextUsage`/`lastTodoPhases` capture, and
// `turnStartedAt`). `shell::memory` owns the process-wide low-memory sampler (not per-Session
// state, so it is not part of this file); `session::subagents` owns the subagent list itself --
// `subagentCount` below is read from its own `subagent_count` accessor, never duplicated here.
//
// Issue #712 (folded in): the live checked-out branch and subagent count both read the CURRENT
// state at compute time, never a turn-scoped snapshot cleared at the next `agent_start` --
// `session::subagents`'s own doc comment has the full reasoning for why that heuristic is not
// ported. Issue #724 (folded in): `branch` is a brand-new field (Rust-only; Electron's own
// `readout.ts`/`SessionReadout` never had one, constitution/epic rule 5 -- "a feature that exists
// only in Rust is acceptable"), computed fresh every readout tick via `git symbolic-ref`/`git
// rev-parse` against the Session's own worktree (never retained across a transient git failure,
// same stance `changes` already takes). The issue's own suggested dedicated worktree-HEAD-file
// watcher is NOT implemented (a disclosed simplification, see the PR body): the issue's own text
// allows "if the watcher is unreliable [on Windows/OneDrive paths], turn end and tool end is the
// floor" -- this recomputes on every tool call end (a superset of "every GIT-touching tool call
// end"), every turn start/end, and every attach, which already exceeds that floor.
//
// `on_frame` is the one extension point `agent::frame`'s own `handle_frame` calls for every
// decoded frame, `on_exit` for process exit (`agent::launch`'s own `spawn_frame_listener`), and
// `on_start_progress` for the ready-wait banner (same listener) -- one call per lane module each,
// cheap and allocation-free as a no-op; lane R5 adds its readout behaviour inside these
// functions, never inside any file under `session/agent/`.
//
// Two small core hooks this lane adds (issue #784, "if you truly need a core change, keep it to
// one line"): `session::agent::launch`'s own `sync_from_state` calls `on_sync_from_state` right
// after persisting its own registry patch (the ONE place `contextUsage`/`todoPhases` can be
// refreshed -- `get_state` syncs at launch, turn settle, new Conversation, and Conversation
// switch all funnel through it already, closing issue #577's staleness for free); `conversations
// .rs`'s `start_new_conversation`/`open_conversation` each call `on_conversation_reset` before
// their own `sync_from_state` call, so a stale `contextUsage`/`todoProgress` reading from the
// PREVIOUS Conversation never survives into the new one (issue #577) -- `changes`/`pullRequest`
// deliberately keep working unchanged across that reset (they are worktree-based, not
// Conversation-based, matching #577's own "Changes and Pull request... correctly stay").

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use crate::git::diff_stat::diff_stat;
use crate::git::git::git_raw;
use crate::github::pr_lookup::{pull_request_for_branch, PullRequestLookup};
use crate::omp::process::ReadyWaitStage;

use super::agent::SessionAgent;

/// Mirrors `SessionAgent.ts`'s own `READOUT_COALESCE_MS`; issue #788's own acceptance criterion
/// ("the readout push does not exceed one event per 100 ms per Session under streaming") is a
/// looser bound than this.
const READOUT_COALESCE_MS: u64 = 50;
const GIT_READ_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, Clone)]
struct ContextUsageState {
    used_tokens: i64,
    window_tokens: i64,
    percent: f64,
}

#[derive(Debug, Clone)]
struct TodoTaskState {
    status: String,
}

#[derive(Debug, Clone)]
struct TodoPhaseState {
    tasks: Vec<TodoTaskState>,
}

#[derive(Debug, Clone)]
struct PullRequestState {
    number: u64,
    url: String,
}

/// Lane R5's own runtime state, held inside `AgentState` by `agent/mod.rs` without that file
/// ever needing to change when this lane adds a field here. Reachable through `SessionAgent`'s
/// own `with_readout_state` accessor (`agent/mod.rs`).
#[derive(Default)]
pub(super) struct State {
    turn_started_at: Option<i64>,
    context_usage: Option<ContextUsageState>,
    /// True once at least one `get_state` has synced THIS run; before that, `context_usage`/
    /// `todo_phases` stay at whatever they already had (typically `None`, hidden) rather than
    /// jumping to a definitive "not available" -- no reading was ever expected yet.
    state_synced: bool,
    todo_phases: Option<Vec<TodoPhaseState>>,
    pull_request: Option<PullRequestState>,
    /// The branch `pull_request`'s own lookup was last REQUESTED for (gate-fix parity with
    /// `refreshPullRequest`'s own `pullRequestBranch`): `None` until the first `compute_readout`
    /// ever runs, so that first run always counts as "a genuine branch change" and looks the PR
    /// up once, matching `launch()`'s own unconditional first `refreshPullRequest()` call.
    pull_request_branch: Option<String>,
    timer_pending: bool,
    in_flight: bool,
    pending: bool,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub(super) async fn on_frame(agent: &SessionAgent, frame_type: &str, frame: &Value) {
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
            // `session::subagents`'s own `on_frame` handles a `task` call's own start (and its
            // own schedule_readout_update call); every OTHER tool call may change `changes`
            // (`readout.ts`'s own "a non-task tool call may change Changes" comment).
            if frame.get("toolName").and_then(Value::as_str) != Some("task") {
                schedule_readout_update(agent).await;
            }
        }
        "tool_execution_end" => {
            schedule_readout_update(agent).await;
        }
        _ => {}
    }
}

pub(super) async fn on_exit(agent: &SessionAgent, _code: Option<i32>, _requested: bool) {
    // A process exit mid-turn must not leave a phantom "turn running" reading behind forever
    // (the chip otherwise never clears once `agent_start` set it, since no `session_settled`
    // frame is coming from a process that has already exited).
    let had_turn = agent
        .with_readout_state(|s| {
            let had = s.turn_started_at.is_some();
            s.turn_started_at = None;
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
    // No-op: the start-progress banner is `session::start_queue`'s own concern.
}

/// `session::agent::launch`'s own `sync_from_state` hook (one line added there, see this file's
/// own header): refreshes `contextUsage`/`todoProgress` from the SAME `get_state` response every
/// other field of that method already reads, so this spec never needs its own `get_state` round
/// trip (mirrors `syncFromState`'s own doc comment).
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
}

/// `conversations.rs`'s own `start_new_conversation`/`open_conversation` hook (issue #577): a
/// brand-new or just-switched-to Conversation's `get_state` has not synced yet, so the PREVIOUS
/// Conversation's `contextUsage`/`todoProgress` must never be shown as if it were this one's --
/// cleared here, BEFORE the caller's own `sync_from_state` call publishes the real (possibly
/// absent) fresh reading. `pull_request`/`pull_request_branch` are deliberately untouched
/// (#577's own "Changes and Pull request... are worktree-based and correctly stay").
pub(super) async fn on_conversation_reset(agent: &SessionAgent) {
    agent
        .with_readout_state(|s| {
            s.state_synced = false;
            s.context_usage = None;
            s.todo_phases = None;
        })
        .await;
}

fn parse_context_usage(value: &Value) -> Option<ContextUsageState> {
    Some(ContextUsageState {
        used_tokens: value.get("tokens").and_then(Value::as_i64)?,
        window_tokens: value.get("contextWindow").and_then(Value::as_i64)?,
        percent: value.get("percent").and_then(Value::as_f64)?,
    })
}

fn parse_todo_phases(value: &Value) -> Option<Vec<TodoPhaseState>> {
    let phases = value.as_array()?;
    Some(
        phases
            .iter()
            .map(|phase| TodoPhaseState {
                tasks: phase
                    .get("tasks")
                    .and_then(Value::as_array)
                    .map(|tasks| {
                        tasks
                            .iter()
                            .map(|task| TodoTaskState {
                                status: task
                                    .get("status")
                                    .and_then(Value::as_str)
                                    .unwrap_or("")
                                    .to_string(),
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
            })
            .collect(),
    )
}

/// Debounced to `READOUT_COALESCE_MS`, then single-flight (a trigger arriving while a
/// computation is already in progress joins the next run instead of starting a second
/// overlapping one) -- port of `scheduleReadoutUpdate`/`runReadoutUpdate`. `pub(super)` (not
/// private): `session::subagents`'s own `on_frame` calls this too, the same way
/// `handleTaskStart`/`handleTaskUpdate` call `this.scheduleReadoutUpdate()` directly in TS.
pub(super) async fn schedule_readout_update(agent: &SessionAgent) {
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
    let agent = agent.arc();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(READOUT_COALESCE_MS)).await;
        agent.with_readout_state(|s| s.timer_pending = false).await;
        run_readout_update(&agent).await;
    });
}

async fn run_readout_update(agent: &Arc<SessionAgent>) {
    loop {
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
        if !rerun {
            return;
        }
    }
}

/// Port of `computeReadout`. A genuine `session.branch` change (never any OTHER trigger -- the
/// whole point of `cachedPullRequest`, `refreshPullRequest`'s own doc comment) is the only thing
/// here that pays for a fresh `gh pr list`; everything else reads the retained
/// `pull_request`/computes fresh from local git/fs state.
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
        refresh_pull_request(agent, &session.worktree_path, &session.branch).await;
    }

    let changes = match diff_stat(Path::new(&session.worktree_path), &session.base_branch).await {
        Some(stat) => {
            serde_json::to_value(stat).expect("DiffStatResult is always JSON-serialisable")
        }
        None => Value::String("not-available".to_string()),
    };
    let branch = compute_branch(&session.worktree_path).await;
    let subagent_count = super::subagents::subagent_count(agent).await;

    let readout = agent
        .with_readout_state(|s| build_readout_value(s, changes, branch, subagent_count))
        .await;
    agent
        .events()
        .emit_readout_update(agent.session_id(), readout);
}

/// Port of `refreshPullRequest`. Discards a now-stale result the same way TS does: if the
/// Session has already moved on to a DIFFERENT branch by the time this lookup resolves, a later
/// call has already superseded it.
async fn refresh_pull_request(agent: &SessionAgent, worktree_path: &str, branch: &str) {
    let lookup = pull_request_for_branch(Path::new(worktree_path), branch).await;
    let still_current = agent
        .with_readout_state(|s| s.pull_request_branch.as_deref() == Some(branch))
        .await;
    if !still_current {
        return;
    }
    agent
        .with_readout_state(|s| {
            s.pull_request = match lookup {
                PullRequestLookup::Found { number, url } => Some(PullRequestState { number, url }),
                PullRequestLookup::None => None,
                // A genuinely indeterminate lookup (gh missing, offline, rate limited, no
                // recognisable remote) retains the previous reading (data-model.md's retention
                // rule), never hides or clears the chip for a momentary blip.
                PullRequestLookup::Unavailable => s.pull_request.clone(),
            };
        })
        .await;
}

/// Issue #724: the live checked-out branch. `git symbolic-ref --short -q HEAD` first (an
/// ordinary branch checkout); `git rev-parse --short HEAD` as the detached-HEAD fallback.
/// `Value::Null` for an unreadable worktree (missing, not a git repo, or no commits yet) -- never
/// retained across a transient failure (unlike `pull_request`): a worktree that is readable one
/// tick and not the next has genuinely changed state, not merely hit a momentary blip.
async fn compute_branch(worktree_path: &str) -> Value {
    let path = Path::new(worktree_path);
    let symbolic = git_raw(
        path,
        &["symbolic-ref", "--short", "-q", "HEAD"],
        Some(GIT_READ_TIMEOUT),
    )
    .await;
    if symbolic.code == 0 {
        let name = symbolic.stdout.trim();
        if !name.is_empty() {
            return json!({ "name": name, "detached": false });
        }
    }
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
    let todo_progress = s.todo_phases.as_ref().and_then(|phases| {
        let total = phases.iter().map(|p| p.tasks.len()).sum::<usize>();
        if total == 0 {
            return None;
        }
        let done = phases
            .iter()
            .flat_map(|p| p.tasks.iter())
            .filter(|t| t.status == "completed")
            .count();
        Some(json!({ "done": done, "total": total }))
    });
    let turn_time = s
        .turn_started_at
        .map(|started_at| json!({ "startedAt": started_at }));
    let pull_request = s
        .pull_request
        .as_ref()
        .map(|pr| json!({ "number": pr.number, "url": pr.url }));
    json!({
        "changes": changes,
        "contextUsage": context_usage,
        "turnTime": turn_time,
        "pullRequest": pull_request,
        "subagentCount": subagent_count,
        "todoProgress": todo_progress,
        "branch": branch,
    })
}
