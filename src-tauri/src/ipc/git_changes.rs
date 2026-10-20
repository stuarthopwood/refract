// IPC handlers for `gitChanges.*` (spec 018 slice 1, issue #464): `list` (the panel's full
// snapshot -- header plus four grouped file lists), per-file `stage`/`unstage` (FR-006/FR-007),
// bulk `stageAll` (FR-004, group-scoped to "changes" or "untracked", re-reading the CURRENT
// status server-side rather than trusting a client-supplied path list) and `unstageAll` (always
// the whole Staged group, the only group it ever applies to) -- Conflicts is excluded from both:
// a developer resolves a conflict per-file, never swept up by a bulk click), `commit` (FR-009 to
// FR-011), `diff` (FR-008: one file's patch body, `git diff`/`git diff --cached` by whether it
// is staged -- added alongside the renderer lane's own US1, no design doc of its own beyond that
// FR), and the watcher lifecycle pair `ensureWatching`/`stopWatching` (FR-015b/FR-016),
// mirroring `ipc/file_explorer.rs`'s own `session_context`/watcher-lifecycle pattern (research.md
// decision 6). The per-session watcher bookkeeping lives in `fs::git_changes_watch_state` (this
// panel's own much-smaller analogue of `fs::explorer_watch_state`, see that module's own header
// comment for why a full tree-diff watcher is not needed here); this file is the thin IPC-shaped
// wiring over it.
//
// Gate round 1 item 13 (issue #464): every mutating handler (`stage`/`unstage`/`stageAll`/
// `unstageAll`/`commit` -- NOT `list`/`diff`, which are read-only) also calls
// `session::readout::schedule_readout_update` right after its own git operation succeeds, so the
// readout's own `changes` chip (a DIFFERENT figure, `diff_stat` against Base) never goes stale
// through a stage/unstage/commit this panel's own watcher ping would otherwise be the only thing
// to catch.

use std::path::PathBuf;

use serde_json::{json, Value};

use crate::fs::git_changes_watch_state as watch_state;
use crate::git::changes_diff::diff_text;
use crate::git::changes_status::{
    commit as git_commit, read_changes_status, stage_files, unstage_files,
};
use crate::git::git::{GitError, GitErrorCode};
use crate::session::readout::schedule_readout_update;

use super::{
    arg_str, invalid_argument, map_git_error, not_found, AppState, Dispatcher, HandlerFuture,
    IpcError,
};

const MAX_SESSION_ID_LENGTH: usize = 256;
/// Matches `ipc::file_explorer`'s own `MAX_RELATIVE_PATH_LENGTH` (a single path, not a whole
/// prompt) -- kept independent rather than importing that one, the two call sites have no reason
/// to be forced to change together.
const MAX_PATH_LENGTH: usize = 4096;
/// A generous ceiling on how many paths one `stage`/`unstage` call can carry, purely to stop a
/// pathological request body from building an unbounded `Vec` -- an ordinary "Stage all" click
/// never comes close (`changes_status::MAX_FILES` already caps how many files this panel ever
/// scores/lists at 200).
const MAX_PATHS_PER_CALL: usize = 10_000;
/// A commit message has no git-enforced length limit when piped on stdin (FR-011's whole reason
/// to use `-F -` over `-m`); this is purely a sanity ceiling against a pathological request body.
const MAX_COMMIT_MESSAGE_LENGTH: usize = 100_000;
/// `"changes"`/`"untracked"` are the only two valid `gitChanges.stageAll` group values -- a
/// generous ceiling, not a tight one, since the exact match below rejects anything else anyway.
const MAX_GROUP_LENGTH: usize = 32;

pub fn register(d: &mut Dispatcher) {
    d.register("gitChanges.list", git_changes_list);
    d.register("gitChanges.stage", git_changes_stage);
    d.register("gitChanges.unstage", git_changes_unstage);
    d.register("gitChanges.stageAll", git_changes_stage_all);
    d.register("gitChanges.unstageAll", git_changes_unstage_all);
    d.register("gitChanges.commit", git_changes_commit);
    d.register("gitChanges.diff", git_changes_diff);
    d.register("gitChanges.ensureWatching", git_changes_ensure_watching);
    d.register("gitChanges.stopWatching", git_changes_stop_watching);
}

fn require_str(
    args: &[Value],
    index: usize,
    max_len: usize,
    type_msg: &'static str,
    size_msg: &'static str,
) -> Result<String, IpcError> {
    match arg_str(args, index) {
        Some(s) if s.len() <= max_len => Ok(s.to_string()),
        Some(_) => Err(invalid_argument(size_msg)),
        None => Err(invalid_argument(type_msg)),
    }
}

fn require_paths(
    args: &[Value],
    index: usize,
    type_msg: &'static str,
) -> Result<Vec<String>, IpcError> {
    let raw = args
        .get(index)
        .and_then(Value::as_array)
        .ok_or_else(|| invalid_argument(type_msg))?;
    if raw.len() > MAX_PATHS_PER_CALL {
        return Err(invalid_argument(
            "This request named too many paths at once",
        ));
    }
    let mut paths = Vec::with_capacity(raw.len());
    for value in raw {
        let s = value.as_str().ok_or_else(|| invalid_argument(type_msg))?;
        if s.len() > MAX_PATH_LENGTH {
            return Err(invalid_argument("This request named an oversized path"));
        }
        paths.push(s.to_string());
    }
    Ok(paths)
}

/// Looks up a Session's worktree path and Base branch (for the header's "from {base}" line,
/// `SessionDetailsCard.tsx`'s own shape, FR-014) -- `Err(not_found)` only when the Session
/// itself no longer exists. Mirrors `ipc::file_explorer::session_context`, minus the
/// repository-path/`worktree_is_valid` plumbing this panel's own slice 1 scope does not need.
async fn session_context(
    state: &AppState,
    session_id: &str,
) -> Result<(PathBuf, String, bool), IpcError> {
    let registry = state.registry.lock().await;
    let session = registry
        .get_session(session_id)
        .ok_or_else(|| not_found("This Session no longer exists"))?;
    Ok((
        PathBuf::from(&session.worktree_path),
        session.base_branch.clone(),
        session.archived_at.is_some(),
    ))
}

pub fn git_changes_list(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let session_id = require_str(
            &args,
            0,
            MAX_SESSION_ID_LENGTH,
            "gitChanges.list expects a string sessionId",
            "gitChanges.list rejected an oversized sessionId",
        )?;
        let (worktree_path, base_branch, _archived) = session_context(&state, &session_id).await?;
        // `read_changes_status` never throws (matches `diff_stat.rs`'s own never-throw
        // convention): `None` is itself a normal, successful result (not-a-repo, git failure, or
        // past the status size cap, FR-018), not an IPC error.
        let snapshot = read_changes_status(&worktree_path, &base_branch).await;
        Ok(json!({ "snapshot": snapshot }))
    })
}

pub fn git_changes_stage(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let session_id = require_str(
            &args,
            0,
            MAX_SESSION_ID_LENGTH,
            "gitChanges.stage expects a string sessionId and a string[] paths",
            "gitChanges.stage rejected an oversized sessionId",
        )?;
        let paths = require_paths(
            &args,
            1,
            "gitChanges.stage expects a string sessionId and a string[] paths",
        )?;
        let (worktree_path, _base_branch, _archived) = session_context(&state, &session_id).await?;
        stage_files(&worktree_path, &paths)
            .await
            .map_err(map_git_error)?;
        schedule_readout_update(&state.session_manager.get_or_create_agent(&session_id)).await;
        Ok(Value::Null)
    })
}

pub fn git_changes_unstage(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let session_id = require_str(
            &args,
            0,
            MAX_SESSION_ID_LENGTH,
            "gitChanges.unstage expects a string sessionId and a string[] paths",
            "gitChanges.unstage rejected an oversized sessionId",
        )?;
        let paths = require_paths(
            &args,
            1,
            "gitChanges.unstage expects a string sessionId and a string[] paths",
        )?;
        let (worktree_path, _base_branch, _archived) = session_context(&state, &session_id).await?;
        unstage_files(&worktree_path, &paths)
            .await
            .map_err(map_git_error)?;
        schedule_readout_update(&state.session_manager.get_or_create_agent(&session_id)).await;
        Ok(Value::Null)
    })
}

/// FR-004: `group` ('changes' or 'untracked' only -- 'conflicts'/'staged' are rejected, matching
/// the renderer's own `BULK_ACTION` map, which never offers a Stage-all button for either) picks
/// which group's CURRENT status (re-read server-side, never a client-supplied path list) this
/// call stages. 2026-10-20 fix: the two groups used to be chained into one combined stage,
/// something a developer clicking the OTHER group's own "Stage all" button never asked for.
pub fn git_changes_stage_all(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let session_id = require_str(
            &args,
            0,
            MAX_SESSION_ID_LENGTH,
            "gitChanges.stageAll expects a string sessionId and a string group",
            "gitChanges.stageAll rejected an oversized sessionId",
        )?;
        let group = require_str(
            &args,
            1,
            MAX_GROUP_LENGTH,
            "gitChanges.stageAll expects a string sessionId and a string group",
            "gitChanges.stageAll rejected an oversized group",
        )?;
        let (worktree_path, base_branch, _archived) = session_context(&state, &session_id).await?;
        if let Some(snapshot) = read_changes_status(&worktree_path, &base_branch).await {
            let paths: Vec<String> = match group.as_str() {
                "changes" => snapshot
                    .groups
                    .changes
                    .into_iter()
                    .map(|entry| entry.path)
                    .collect(),
                "untracked" => snapshot
                    .groups
                    .untracked
                    .into_iter()
                    .map(|entry| entry.path)
                    .collect(),
                _ => {
                    return Err(invalid_argument(
                        "gitChanges.stageAll group must be \"changes\" or \"untracked\"",
                    ))
                }
            };
            stage_files(&worktree_path, &paths)
                .await
                .map_err(map_git_error)?;
            schedule_readout_update(&state.session_manager.get_or_create_agent(&session_id)).await;
        } else {
            // Gate round 2 item 13 (#464): `read_changes_status` returning `None` (not a repo, a
            // git failure, or past the status size cap -- the same `None` `list`/`diff` treat as
            // a normal non-error "not available" state for their own read-only purpose) means
            // this action did precisely nothing; falling through to `Ok(Value::Null)` below
            // would report success for a stageAll that never ran. Same `GitError`/`map_git_error`
            // shape every other failure path in this file already uses.
            return Err(map_git_error(GitError::new(
                GitErrorCode::GitFailed,
                "Couldn't read this worktree's Git status",
            )));
        }
        Ok(Value::Null)
    })
}

pub fn git_changes_unstage_all(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let session_id = require_str(
            &args,
            0,
            MAX_SESSION_ID_LENGTH,
            "gitChanges.unstageAll expects a string sessionId",
            "gitChanges.unstageAll rejected an oversized sessionId",
        )?;
        let (worktree_path, base_branch, _archived) = session_context(&state, &session_id).await?;
        if let Some(snapshot) = read_changes_status(&worktree_path, &base_branch).await {
            let paths: Vec<String> = snapshot
                .groups
                .staged
                .into_iter()
                .map(|entry| entry.path)
                .collect();
            unstage_files(&worktree_path, &paths)
                .await
                .map_err(map_git_error)?;
            schedule_readout_update(&state.session_manager.get_or_create_agent(&session_id)).await;
        } else {
            // Gate round 2 item 13 (#464): same reasoning as `git_changes_stage_all`'s own
            // `else` branch above -- a failed status read must not be reported as a successful
            // no-op unstageAll.
            return Err(map_git_error(GitError::new(
                GitErrorCode::GitFailed,
                "Couldn't read this worktree's Git status",
            )));
        }
        Ok(Value::Null)
    })
}

pub fn git_changes_commit(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let session_id = require_str(
            &args,
            0,
            MAX_SESSION_ID_LENGTH,
            "gitChanges.commit expects a string sessionId and a string message",
            "gitChanges.commit rejected an oversized sessionId",
        )?;
        let message = require_str(
            &args,
            1,
            MAX_COMMIT_MESSAGE_LENGTH,
            "gitChanges.commit expects a string sessionId and a string message",
            "gitChanges.commit rejected an oversized message",
        )?;
        if message.trim().is_empty() {
            return Err(invalid_argument(
                "gitChanges.commit requires a non-empty message",
            ));
        }
        let (worktree_path, _base_branch, _archived) = session_context(&state, &session_id).await?;
        git_commit(&worktree_path, &message)
            .await
            .map_err(map_git_error)?;
        schedule_readout_update(&state.session_manager.get_or_create_agent(&session_id)).await;
        Ok(Value::Null)
    })
}

/// `gitChanges.diff(sessionId, path, staged, untracked)` (FR-008): one file's diff body, by
/// whether it is currently staged -- `git diff --cached` vs the plain worktree `git diff`.
/// `untracked` (#1101, item 4): true for a file with no index/HEAD side to diff against at all
/// (re-confirmed server-side, `changes_diff.rs::confirm_untracked`, gate round 1 HIGH 1(e) --
/// never the renderer's own flag alone) -- the Rust side then synthesises the whole file as
/// added lines instead of an empty patch. `path` is checked only for length here (the same bound
/// `stage`/`unstage` apply to each path in their own list); the real containment rule for the
/// TRACKED path is git's own `--` argv-literal diff against this Session's worktree. **Gate
/// round 1 HIGH 1: the UNTRACKED path is different** -- `untracked_file_patch` reads the
/// filesystem directly (there is no git blob to operate on), so it layers
/// `fs::resolve::resolve_in_worktree`'s own disk-aware, symlink-walking containment proof on top,
/// and renders a symlink entry as git's own view (its target text) rather than ever reading
/// through it.
pub fn git_changes_diff(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let session_id = require_str(
            &args,
            0,
            MAX_SESSION_ID_LENGTH,
            "gitChanges.diff expects a string sessionId, a string path, a boolean staged and a boolean untracked",
            "gitChanges.diff rejected an oversized sessionId",
        )?;
        let path = require_str(
            &args,
            1,
            MAX_PATH_LENGTH,
            "gitChanges.diff expects a string sessionId, a string path, a boolean staged and a boolean untracked",
            "gitChanges.diff rejected an oversized path",
        )?;
        let staged = args.get(2).and_then(Value::as_bool).unwrap_or(false);
        let untracked = args.get(3).and_then(Value::as_bool).unwrap_or(false);
        let (worktree_path, _base_branch, _archived) = session_context(&state, &session_id).await?;
        let patch = diff_text(&worktree_path, &path, staged, untracked)
            .await
            .map_err(map_git_error)?;
        Ok(json!({ "patch": patch }))
    })
}

pub fn git_changes_ensure_watching(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let session_id = require_str(
            &args,
            0,
            MAX_SESSION_ID_LENGTH,
            "gitChanges.ensureWatching expects a string sessionId",
            "gitChanges.ensureWatching rejected an oversized sessionId",
        )?;
        let (worktree_path, _base_branch, archived) = session_context(&state, &session_id).await?;
        watch_state::ensure_watcher(
            state.app_handle.clone(),
            &session_id,
            &worktree_path,
            archived,
        );
        Ok(Value::Null)
    })
}

pub fn git_changes_stop_watching(_state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let session_id = require_str(
            &args,
            0,
            MAX_SESSION_ID_LENGTH,
            "gitChanges.stopWatching expects a string sessionId",
            "gitChanges.stopWatching rejected an oversized sessionId",
        )?;
        watch_state::stop_watcher(&session_id);
        Ok(Value::Null)
    })
}
