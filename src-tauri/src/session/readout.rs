// Readout pills (spec 004: context/token usage, changes, turn time, pull request, subagents,
// todo progress), the live checked-out branch (#724), and the readout half of the memory-warning
// lane (lane R5, issue #788). Pre-declared so lane R5 is the only lane that ever edits this file
// (issue #784, "Pre-declare per-lane Rust files").
//
// Port of `src/main/omp/readout.ts`'s own `assembleReadout` plus `SessionAgent.ts`'s own
// `computeReadout`/`scheduleReadoutUpdate`/`runReadoutUpdate`/`refreshPullRequest`/
// `syncFromState`'s `lastContextUsage`/`lastTodoPhases`/`turnStartedAt` capture.
// `shell::memory` owns the low-memory sampler; `session::subagents` owns the subagent list
// (`subagentCount` reads its own `subagent_count` accessor, never duplicated here).
//
// Round 2 (code/test/perf gate round 1): `State::last_readout` is retained, exposed via
// `current_readout_value` so `build_snapshot` returns the live value, not the permanent empty
// shape. The PR chip re-poll is back (`on_launch` starts a per-agent 60 s timer, stopped by
// `on_exit`, matching `SessionAgent.ts`'s own `prPollTimer`); `refresh_pull_request` is spawned,
// never awaited inline. A rerun queued mid-compute re-arms the FULL `READOUT_COALESCE_MS`
// (100 ms) debounce. `diff_stat`/`compute_branch` run concurrently; `readout:update` is not
// pushed for a hidden Session.
// Gate round 2 (code/perf): `settle_running_to_exited` schedules a readout update on change;
// `on_launch` seeds `pull_request_branch` before its first refresh (closes a double `gh` lookup)
// and jitters that first sleep 0-60s; a duration-only progress change no longer re-broadcasts.
//
// Issue #712 (folded in): the live checked-out branch and subagent count both read the CURRENT
// state at compute time, never a turn-scoped snapshot cleared at the next `agent_start` --
// `session::subagents`'s own doc comment has the full reasoning for why that heuristic is not
// ported. Issue #724 (folded in): `branch` is a brand-new, Rust-only field (constitution/epic
// rule 5), computed fresh every readout tick via `git symbolic-ref`/`git rev-parse` against the
// Session's own worktree (never retained across a transient git failure, same stance `changes`
// already takes). Spec 019 adds the issue's worktree-HEAD watch (`readout_head_watch.rs`,
// started by `on_launch`, stopped by `on_exit`) on top of the existing refresh points: every
// tool-call end, turn start/end, and attach.
//
// `on_frame` is the one extension point `agent::frame`'s own `handle_frame` calls for every
// decoded frame, `on_exit` for process exit, and `on_start_progress` for the ready-wait banner
// (same listener) -- one call per lane module each, cheap and allocation-free as a no-op; lane
// R5 adds its readout behaviour inside these, never inside any file under `session/agent/`.
//
// Core hooks this lane adds (issue #784, "keep it to one line"): `launch()` calls `on_launch`
// right before `sync_from_state` (the PR-poll timer, once per life); `sync_from_state` calls
// `on_sync_from_state` right after persisting its registry patch (where `contextUsage`/
// `todoPhases` refresh); `conversations.rs`'s `start_new_conversation`/`open_conversation` each
// call `on_conversation_reset` before their own `sync_from_state` (issue #577) -- `changes`/
// `pullRequest` deliberately keep working unchanged across that reset (worktree-based, not
// Conversation-based).

use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use crate::git::diff_stat::diff_stat;
use crate::git::git::git_raw;
use crate::github::pr_lookup::{pull_request_for_branch, PullRequestLookup};
use crate::omp::process::ReadyWaitStage;

use super::agent::SessionAgent;

#[path = "readout_todo.rs"]
mod readout_todo;
use readout_todo::{build_todo_tree, compute_up_next, parse_todo_phases, TodoPhaseState};
#[path = "readout_activity.rs"]
mod readout_activity;
use readout_activity::ActivityState;

/// Issue #788's own acceptance criterion: "the readout push does not exceed one event per 100 ms
/// per Session under streaming" -- test-review/perf gate round 1 finding: the PREVIOUS 50 ms value
/// plus an immediate-rerun-on-pending loop could exceed this; both are fixed together (this
/// constant raised to the bound itself, and the rerun path now re-arms the full debounce instead
/// of looping with no wait -- see `run_readout_update`'s own doc comment).
const READOUT_COALESCE_MS: u64 = 100;
const GIT_READ_TIMEOUT: Duration = Duration::from_secs(3);
/// Mirrors `SessionAgent.ts`'s own `PR_POLL_INTERVAL_MS`.
const PR_POLL_INTERVAL_MS: u64 = 60_000;

#[derive(Debug, Clone)]
struct ContextUsageState {
    used_tokens: i64,
    window_tokens: i64,
    percent: f64,
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
    /// Code-review round 1: the last successfully assembled `SessionReadout` wire value, so a
    /// Session snapshot (`ipc::conversations::build_snapshot`) can return the live reading
    /// instead of the permanent "nothing read yet" shape. `None` until the first `compute_readout`
    /// run completes.
    last_readout: Option<Value>,
    /// Performance/code-review round 1: bumped by `on_launch` (a new life starting a new PR-poll
    /// timer) and by `on_exit` (stopping it) -- the spawned timer loop checks this on every tick
    /// and exits the moment it no longer matches, so at most one timer is ever live per agent.
    pr_poll_generation: u64,
    /// Issue #687: latest intent/tool, retry and compaction state for the current-work banner.
    activity: ActivityState,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Gate round 2 (perf MEDIUM): 0..`cap_ms` jitter for the PR poll's first sleep, so Sessions
/// launched together don't tick in lockstep (nanosecond-modulo, no new `rand` dependency).
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
            // `session::subagents`'s own `on_frame` handles a `task` call's own start (and its
            // own schedule_readout_update call); every OTHER tool call may change `changes`
            // (`readout.ts`'s own "a non-task tool call may change Changes" comment).
            if frame.get("toolName").and_then(Value::as_str) != Some("task") {
                schedule_readout_update(agent).await;
            }
        }
        "tool_execution_end" => {
            // Issue #700/#701 slice (a), FINDINGS item 62: the `todo` tool's own call-end frame
            // already carries the FULL, up-to-date `phases` tree (never a delta) -- replacing
            // `todo_phases` with it here lets the pinned panel update live, mid-turn, rather
            // than waiting for the next `sync_from_state` (launch, Conversation switch, command
            // refresh, or settle). A malformed/absent `details.phases` leaves the retained tree
            // untouched (stale-but-present beats a flicker to empty on a transient shape miss).
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
    // A process exit mid-turn must not leave a phantom "turn running" reading behind forever
    // (the chip otherwise never clears once `agent_start` set it, since no `session_settled`
    // frame is coming from a process that has already exited). Also stops the PR-poll timer
    // (code-review round 1): bumping the generation makes the spawned loop's own next check see
    // a mismatch and return.
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
    // No-op: the start-progress banner is `session::start_queue`'s own concern.
}

/// `session::agent::launch`'s own hook, called once per `launch()` attempt. Starts a NEW
/// generation's poll loop: an immediate refresh (spawned, matching `launch()`'s own
/// unconditional first `void this.refreshPullRequest()`), then one every `PR_POLL_INTERVAL_MS`,
/// until `on_exit` bumps the generation this loop was spawned with past what `State` holds.
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
                // Gate round 2 (perf MEDIUM): seed `pull_request_branch` before this first
                // refresh so its own `still_current` check succeeds instead of being discarded
                // -- was causing a second, redundant `gh` lookup every launch (Electron's
                // `SessionAgent.ts:1861` sets this before calling `refreshPullRequest()`).
                agent
                    .with_readout_state(|s| s.pull_request_branch = Some(session.branch.clone()))
                    .await;
                super::readout_head_watch::start(&agent, &session.worktree_path).await;
            }
            refresh_pull_request(&agent, &session.worktree_path, &session.branch).await;
            schedule_readout_update(&agent).await;
            // Gate round 2 (perf MEDIUM): jitter only the FIRST sleep, so Sessions launched
            // together don't tick their 60s PR polls together.
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
/// (#577's own "Changes and Pull request... are worktree-based and correctly stay"). Also
/// schedules a readout update (test-review round 1 MEDIUM finding): if the caller's own
/// `get_state` fails right after this, the old `contextUsage`/`subagentCount` must not keep
/// showing on screen, which only a fresh emit (even with the now-cleared values) corrects.
pub(super) async fn on_conversation_reset(agent: &SessionAgent) {
    agent
        .with_readout_state(|s| {
            s.state_synced = false;
            s.context_usage = None;
            s.todo_phases = None;
            s.activity.reset();
        })
        .await;
    schedule_readout_update(agent).await;
}

/// Code-review round 1: the last assembled readout, for `ipc::conversations::build_snapshot`'s
/// own one-line hook. The documented "nothing read yet" empty shape when no `compute_readout` has
/// ever completed for this agent (matches `EMPTY_READOUT`, never a guessed value).
pub async fn current_readout_value(agent: &SessionAgent) -> Value {
    agent
        .with_readout_state(|s| s.last_readout.clone())
        .await
        .unwrap_or_else(empty_readout)
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

/// Debounced to `READOUT_COALESCE_MS`, then single-flight (a trigger arriving while a
/// computation is already in progress joins the next run instead of starting a second
/// overlapping one) -- port of `scheduleReadoutUpdate`/`runReadoutUpdate`. `pub(crate)` (gate
/// round 1 item 13, issue #464: widened from `pub(super)` so `ipc::git_changes`/
/// `fs::git_changes_watch_state` can call it too, same signature/behaviour, unchanged for every
/// existing caller): `session::subagents`'s own `on_frame` calls this too, the same way
/// `handleTaskStart`/`handleTaskUpdate` call `this.scheduleReadoutUpdate()` directly in TS.
///
/// A plain `fn` returning an explicitly boxed future, NOT `async fn` (gate-fix, round 2): this
/// function and `compute_readout` call each other (`compute_readout`'s own branch-changed PR
/// refresh now re-triggers this), and two mutually-recursive `async fn`s each spawned inside
/// `tokio::spawn` hit rustc's "cycle detected when computing type of opaque" (E0391) resolving
/// the generated coroutine's `Send` bound -- the opaque return type of each needs the other's
/// already resolved. Declaring THIS one's return type concretely up front (not inferred from its
/// body) breaks the cycle; every call site still just calls it and `.await`s the result exactly
/// as before.
pub(crate) fn schedule_readout_update(
    agent: &SessionAgent,
) -> Pin<Box<dyn Future<Output = ()> + Send + 'static>> {
    let agent = agent.arc();
    Box::pin(async move {
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

/// Performance/test-review gate round 1: a trigger arriving while a compute is already running
/// used to set `pending` and have this function loop straight back into another run with NO
/// further wait -- under a fast, steady stream of triggers (a streaming turn) that could emit far
/// more often than `READOUT_COALESCE_MS` apart, breaking issue #788's own "at most one event per
/// 100 ms" acceptance bound. The rerun now goes back through `schedule_readout_update` instead,
/// which re-arms the FULL debounce -- so two emissions are always at least `READOUT_COALESCE_MS`
/// apart, never zero.
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

/// Port of `computeReadout`. A genuine `session.branch` change (never any OTHER trigger -- the
/// whole point of `cachedPullRequest`, `refreshPullRequest`'s own doc comment) still triggers a
/// fresh `gh pr list`, but SPAWNED now (performance gate round 1 HIGH), never awaited inline: a
/// `gh` network call (up to a 5 s timeout) must not hold back `changes`/`branch`/`turnTime`/
/// `subagentCount` while this single-flight run waits on it.
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

    // Performance gate round 1 LOW: run concurrently, not one after another -- each is its own
    // independent git/fs read with no data dependency on the other.
    let (diff_result, branch) = tokio::join!(
        diff_stat(Path::new(&session.worktree_path), &session.base_branch),
        compute_branch(&session.worktree_path)
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
    // Code-review round 1: `readout:update` follows `transcript:patch`'s own visibility rule.
    if agent.is_visible() {
        agent
            .events()
            .emit_readout_update(agent.session_id(), readout);
    }
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
pub(super) async fn compute_branch(worktree_path: &str) -> Value {
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
    // Issue #700/#701 slice (a): the full retained tree (every phase, every task's own
    // `content`/`status`/`blocker`) -- `todoProgress`'s own done/total counting moved OUT of
    // Rust entirely (decision record item 4: "the pill, card and panel all take these from the
    // ONE derive", `todoDerive.ts`, shared with #687/#526, never duplicated here).
    let todo_tree = build_todo_tree(s.todo_phases.as_ref());
    // Issue #941 "Up next" (`readout_todo.rs`): the agent's own pending Todo phases, shown
    // after a turn's Stages; `null` when there is no todo list, or every phase is finished.
    let todo_phases_up_next = compute_up_next(s.todo_phases.as_ref());
    let turn_time = s
        .turn_started_at
        .map(|started_at| json!({ "startedAt": started_at }));
    let pull_request = s
        .pull_request
        .as_ref()
        .map(|pr| json!({ "number": pr.number, "url": pr.url }));
    let mut readout = json!({
        "changes": changes,
        "contextUsage": context_usage,
        "turnTime": turn_time,
        "pullRequest": pull_request,
        "subagentCount": subagent_count,
        "todoTree": todo_tree,
        "todoPhases": todo_phases_up_next,
        "branch": branch,
    });
    s.activity.write_into(&mut readout);
    readout
}
