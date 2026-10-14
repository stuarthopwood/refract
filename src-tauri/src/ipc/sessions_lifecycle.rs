// IPC handlers for the registry-only `sessions.*` subset (contracts/ipc.md "Sessions", tasks.md
// T019/T024/T041/T042/T043/T068): `.list`/`.create`/`.rename` (Phase 2(b)), `.archive`/
// `.restore` (T041), `.deleteCheck`/`.delete` (T042), `.recreateWorktree` (T043), and
// `.diffStat`/`.revealWorktree` (T068, lane R2 #785). `.list` now completes its live-runtime
// fields via `session::SessionManager::summaries` (Phase 3, tasks.md T024) instead of the "never
// opened this run" default placeholder.
//
// Split from the former `ipc/sessions.rs` (issue #784, "Pre-declare per-lane Rust files") so
// lane R2 (#785, session worktree and lifecycle: archive, restore, delete, recreate, diffStat,
// reveal, remotes) is the only lane that ever edits this file; `.open`/`.stopAgent`/
// `.setVisible` live in the sibling `ipc/sessions_agent.rs` instead (lane R3, #786).
//
// Simplifications from `sessions.ts` (lane R3/#786 and lane R7/#790 territory, neither built
// yet in this crate): no `resumingIds` busy-lock exists here, so `.archive`/`.delete` skip the
// guard against a concurrent `sessions.resume` (lane R3's own channel); no file-explorer
// watcher exists here, so `.archive`/`.delete`/`.recreateWorktree` skip every
// `stopFileExplorerWatcher`/`setFileExplorerSessionBusy`/`notifyFileExplorerReset`/
// `forgetFileExplorerSession` call the TS handlers make (lane R7's own territory).

use std::path::Path;

use serde_json::Value;

use crate::git::diff_stat::diff_stat;
use crate::git::worktree_delete::remove_session_worktree;
use crate::git::worktree_delete_check::delete_check_for_session;
use crate::git::worktree_validity::comparable_path;
use crate::git::worktrees::{
    add_worktree_with_generated_name, branch_exists, list_branches, recreate_worktree,
    remove_worktree,
};
use crate::store::registry::{Session, SessionPatch};

use super::{
    arg_str, invalid_argument, map_git_error, map_registry_error, not_found, now_iso8601, AppState,
    Dispatcher, HandlerFuture, IpcError,
};

pub fn register(d: &mut Dispatcher) {
    d.register("sessions.list", sessions_list);
    d.register("sessions.create", sessions_create);
    d.register("sessions.rename", sessions_rename);
    d.register("sessions.archive", sessions_archive);
    d.register("sessions.restore", sessions_restore);
    d.register("sessions.deleteCheck", sessions_delete_check);
    d.register("sessions.delete", sessions_delete);
    d.register("sessions.recreateWorktree", sessions_recreate_worktree);
    d.register("sessions.diffStat", sessions_diff_stat);
    d.register("sessions.revealWorktree", sessions_reveal_worktree);
}

pub fn sessions_list(state: AppState, _args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move { Ok(Value::Array(state.session_manager.summaries().await)) })
}

pub fn sessions_create(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let input = match args.first().and_then(Value::as_object) {
            Some(input) => input,
            None => {
                return Err(invalid_argument(
                    "sessions.create expects { repositoryId, baseBranch }",
                ))
            }
        };
        let repository_id = match input.get("repositoryId").and_then(Value::as_str) {
            Some(id) => id.to_string(),
            None => {
                return Err(invalid_argument(
                    "sessions.create expects { repositoryId: string, baseBranch: string }",
                ))
            }
        };
        let base_branch = match input.get("baseBranch").and_then(Value::as_str) {
            Some(branch) => branch.to_string(),
            None => {
                return Err(invalid_argument(
                    "sessions.create expects { repositoryId: string, baseBranch: string }",
                ))
            }
        };

        let repository = {
            let registry = state.registry.lock().await;
            registry
                .get_repository(&repository_id)
                .ok_or_else(|| not_found(format!("Repository not found: {repository_id}")))?
                .clone()
        };
        let repo_path = std::path::Path::new(&repository.path);

        let branches = list_branches(repo_path).await.map_err(map_git_error)?;
        if !branches.iter().any(|b| b == &base_branch) {
            return Err(super::IpcError::new(
                "base-missing",
                format!("Base branch not found: {base_branch}"),
            ));
        }

        let added = add_worktree_with_generated_name(repo_path, &base_branch)
            .await
            .map_err(map_git_error)?;
        let now = now_iso8601();
        let session = Session {
            id: uuid::Uuid::new_v4().to_string(),
            repository_id: repository_id.clone(),
            name: added.branch.clone(),
            branch: added.branch.clone(),
            base_branch,
            worktree_path: added.worktree_path.to_string_lossy().into_owned(),
            session_dir: None,
            current_conversation: None,
            last_message_count: None,
            last_model: None,
            last_thinking_level: None,
            created_at: now.clone(),
            last_activity_at: now,
            archived_at: None,
            current_turn_subagents: None,
            stopped_on_request_conversation: None,
            stopped_on_request_at_size: None,
        };

        if let Err(err) = state
            .registry
            .lock()
            .await
            .add_session(session.clone())
            .await
        {
            // Security remediation (Medium, ported from `sessions.ts`): the Repository may have
            // been removed while `list_branches`/`add_worktree_with_generated_name` above were
            // still in flight -- roll back the worktree/branch just created so it is not
            // stranded.
            let _ = remove_worktree(repo_path, &added.worktree_path, &added.branch, true).await;
            return Err(map_registry_error(err));
        }

        Ok(serde_json::to_value(session).expect("Session is always JSON-serialisable"))
    })
}

pub fn sessions_rename(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let id = match args.first().and_then(Value::as_str) {
            Some(id) => id.to_string(),
            None => {
                return Err(invalid_argument(
                    "sessions.rename expects (id, name) strings",
                ))
            }
        };
        let name = match args.get(1).and_then(Value::as_str) {
            Some(name) => name.to_string(),
            None => {
                return Err(invalid_argument(
                    "sessions.rename expects (id, name) strings",
                ))
            }
        };
        state
            .registry
            .lock()
            .await
            .update_session_name(&id, name)
            .await
            .map_err(map_registry_error)?;
        Ok(Value::Null)
    })
}

/// `sessions.archive` (T041): stops the live agent (if any -- idempotent for an already-stopped
/// Session, same as `SessionAgent::shutdown`'s own contract), then stamps `archivedAt`. See this
/// file's header for the `resumingIds`/file-explorer simplifications ported out of
/// `sessions.ts`'s own handler.
pub fn sessions_archive(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let id = match arg_str(&args, 0) {
            Some(id) => id.to_string(),
            None => return Err(invalid_argument("sessions.archive expects a string id")),
        };
        if state.registry.lock().await.get_session(&id).is_none() {
            return Err(not_found(format!("Session not found: {id}")));
        }
        state
            .session_manager
            .get_or_create_agent(&id)
            .shutdown()
            .await;
        state
            .registry
            .lock()
            .await
            .update_session(
                &id,
                SessionPatch {
                    archived_at: Some(Some(now_iso8601())),
                    ..Default::default()
                },
            )
            .await
            .map_err(map_registry_error)?;
        state.session_manager.notify_list_changed();
        Ok(Value::Null)
    })
}

/// `sessions.restore` (T041): clears `archivedAt` back to `null`.
pub fn sessions_restore(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let id = match arg_str(&args, 0) {
            Some(id) => id.to_string(),
            None => return Err(invalid_argument("sessions.restore expects a string id")),
        };
        if state.registry.lock().await.get_session(&id).is_none() {
            return Err(not_found(format!("Session not found: {id}")));
        }
        state
            .registry
            .lock()
            .await
            .update_session(
                &id,
                SessionPatch {
                    archived_at: Some(None),
                    ..Default::default()
                },
            )
            .await
            .map_err(map_registry_error)?;
        state.session_manager.notify_list_changed();
        Ok(Value::Null)
    })
}

/// `sessions.deleteCheck` (T042): feeds the delete confirmation text. Issue #599 (see
/// `git::worktree_delete`'s own header): decides purely from live git state, never `fs.stat`ing
/// the worktree folder.
pub fn sessions_delete_check(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let id = match arg_str(&args, 0) {
            Some(id) => id.to_string(),
            None => return Err(invalid_argument("sessions.deleteCheck expects a string id")),
        };
        let (session, repository) = {
            let registry = state.registry.lock().await;
            let session = registry
                .get_session(&id)
                .ok_or_else(|| not_found(format!("Session not found: {id}")))?
                .clone();
            let repository = registry
                .get_repository(&session.repository_id)
                .ok_or_else(|| {
                    not_found(format!("Repository not found: {}", session.repository_id))
                })?
                .clone();
            (session, repository)
        };
        let check = delete_check_for_session(
            Path::new(&repository.path),
            Path::new(&session.worktree_path),
            &session.branch,
        )
        .await
        .map_err(map_git_error)?;
        Ok(serde_json::to_value(check).expect("DeleteCheck is always JSON-serialisable"))
    })
}

/// `sessions.delete` (T042): removes the worktree (issue #599's safe-delete path), best-effort
/// deletes this Session's own Conversation transcript files, then removes the registry entry.
/// See this file's header for the `resumingIds`/file-explorer simplifications.
pub fn sessions_delete(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let id = match arg_str(&args, 0) {
            Some(id) => id.to_string(),
            None => {
                return Err(invalid_argument(
                    "sessions.delete expects (id, { confirmed })",
                ))
            }
        };
        let options = match args.get(1).and_then(Value::as_object) {
            Some(options) => options,
            None => {
                return Err(invalid_argument(
                    "sessions.delete expects (id, { confirmed })",
                ))
            }
        };
        if options.get("confirmed").and_then(Value::as_bool) != Some(true) {
            return Err(invalid_argument(
                "sessions.delete requires { confirmed: true }",
            ));
        }
        let (session, repository) = {
            let registry = state.registry.lock().await;
            let session = registry
                .get_session(&id)
                .ok_or_else(|| not_found(format!("Session not found: {id}")))?
                .clone();
            let repository = registry
                .get_repository(&session.repository_id)
                .ok_or_else(|| {
                    not_found(format!("Repository not found: {}", session.repository_id))
                })?
                .clone();
            (session, repository)
        };

        remove_session_worktree(
            Path::new(&repository.path),
            Path::new(&session.worktree_path),
            &session.branch,
            true,
        )
        .await
        .map_err(map_git_error)?;

        if let Some(session_dir) = &session.session_dir {
            if is_strict_descendant_of_omp_sessions(session_dir) {
                delete_session_conversations(session_dir).await;
            } else {
                log::warn!(
                    "sessions.delete: refusing to delete sessionDir outside ~/.omp/agent/sessions: {session_dir}"
                );
            }
        }

        state
            .registry
            .lock()
            .await
            .remove_session(&id)
            .await
            .map_err(map_registry_error)?;
        state.session_manager.remove_agent(&id);
        state.session_manager.notify_list_changed();
        Ok(Value::Null)
    })
}

/// `sessions.recreateWorktree` (T043): recreates the worktree at its original path, attaching
/// the existing branch. `branch-missing` is this handler's own custom error (not a `GitError`),
/// matching `sessions.ts`'s own handler.
pub fn sessions_recreate_worktree(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let id = match arg_str(&args, 0) {
            Some(id) => id.to_string(),
            None => {
                return Err(invalid_argument(
                    "sessions.recreateWorktree expects a string id",
                ))
            }
        };
        let (session, repository) = {
            let registry = state.registry.lock().await;
            let session = registry
                .get_session(&id)
                .ok_or_else(|| not_found(format!("Session not found: {id}")))?
                .clone();
            let repository = registry
                .get_repository(&session.repository_id)
                .ok_or_else(|| {
                    not_found(format!("Repository not found: {}", session.repository_id))
                })?
                .clone();
            (session, repository)
        };
        let repo_path = Path::new(&repository.path);
        if !branch_exists(repo_path, &session.branch).await {
            return Err(IpcError::new(
                "branch-missing",
                format!("Branch not found: {}", session.branch),
            ));
        }
        recreate_worktree(
            repo_path,
            Path::new(&session.worktree_path),
            &session.branch,
        )
        .await
        .map_err(map_git_error)?;
        state.session_manager.notify_list_changed();
        Ok(Value::Null)
    })
}

/// `sessions.diffStat` (T068): read-only, so `diff_stat` itself never throws past its own
/// boundary -- this handler's own `Result` is always `Ok`, carrying `null` for a timeout, a
/// missing worktree, a missing Base branch, or any git failure.
pub fn sessions_diff_stat(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let id = match arg_str(&args, 0) {
            Some(id) => id.to_string(),
            None => return Err(invalid_argument("sessions.diffStat expects a string id")),
        };
        let session = state
            .registry
            .lock()
            .await
            .get_session(&id)
            .cloned()
            .ok_or_else(|| not_found(format!("Session not found: {id}")))?;
        let result = diff_stat(Path::new(&session.worktree_path), &session.base_branch).await;
        Ok(serde_json::to_value(result).expect("Option<DiffStatResult> is always serialisable"))
    })
}

/// `sessions.revealWorktree` (T068): looks the worktree up by Session id in the registry, never
/// a path handed in by the renderer (constitution V). No `tauri_plugin_opener`/`shell.openPath`
/// equivalent is called from Rust elsewhere in this crate yet, so this spawns Windows'
/// `explorer` directly (this build is Windows-only, per `git::git`'s own `CREATE_NO_WINDOW`
/// comment).
pub fn sessions_reveal_worktree(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let id = match arg_str(&args, 0) {
            Some(id) => id.to_string(),
            None => {
                return Err(invalid_argument(
                    "sessions.revealWorktree expects a string id",
                ))
            }
        };
        let session = state
            .registry
            .lock()
            .await
            .get_session(&id)
            .cloned()
            .ok_or_else(|| not_found(format!("Session not found: {id}")))?;
        let worktree_is_directory = tokio::fs::metadata(&session.worktree_path)
            .await
            .map(|metadata| metadata.is_dir())
            .unwrap_or(false);
        if !worktree_is_directory {
            return Err(IpcError::new(
                "worktree-missing",
                format!("Worktree missing: {}", session.worktree_path),
            ));
        }
        match tokio::process::Command::new("explorer")
            .arg(&session.worktree_path)
            .spawn()
        {
            Ok(_) => Ok(Value::Null),
            Err(err) => Err(IpcError::new("worktree-failed", err.to_string())),
        }
    })
}

/// Security: a Session's `session_dir` is learned from OMP's own `get_state`, but the registry
/// is just a JSON file -- a corrupted or hand-edited one must never make `sessions.delete`
/// remove an arbitrary path. Only a true descendant of the real OMP sessions root (never the
/// root itself) is ever touched. Mirrors `sessions.ts`'s own `isStrictDescendantOfOmpSessions`;
/// `dirs::home_dir()` is the same home-directory resolution `omp/process.rs` already uses for
/// `~/.omp/logs`, and `comparable_path` is the same lexical-resolve-plus-lowercase comparison
/// key `git::worktree_validity`/`store::registry` already use for a path that may not (yet)
/// exist on disk.
fn is_strict_descendant_of_omp_sessions(dir: &str) -> bool {
    let Some(home) = dirs::home_dir() else {
        return false;
    };
    let sessions_root = comparable_path(
        &home
            .join(".omp")
            .join("agent")
            .join("sessions")
            .to_string_lossy(),
    );
    let resolved = comparable_path(dir);
    resolved != sessions_root
        && resolved.starts_with(&format!("{sessions_root}{}", std::path::MAIN_SEPARATOR))
}

/// Deletes only this Session's own Conversation files (`*.jsonl`) and their sibling same-stem
/// directories (subagent transcripts, data-model.md), then removes `session_dir` itself only
/// once it is empty -- never a wholesale recursive remove, which could take unrelated sibling
/// Conversations or (if `session_dir` were ever wrong) far more than that. Best-effort
/// throughout (mirrors `sessions.ts`'s own `deleteSessionConversations`): every removal failure
/// is swallowed, since a Session that could not fully clean up its own transcript files still
/// must finish being deleted from the registry.
async fn delete_session_conversations(session_dir: &str) {
    let dir = Path::new(session_dir);
    let mut entries = match tokio::fs::read_dir(dir).await {
        Ok(entries) => entries,
        Err(_) => return,
    };
    let mut names = Vec::new();
    while let Ok(Some(entry)) = entries.next_entry().await {
        names.push(entry.file_name());
    }
    for name in names {
        let name = name.to_string_lossy().into_owned();
        if !name.to_lowercase().ends_with(".jsonl") {
            continue;
        }
        let file_path = dir.join(&name);
        let sibling_dir = dir.join(&name[..name.len() - ".jsonl".len()]);
        let _ = tokio::fs::remove_file(&file_path).await;
        let _ = tokio::fs::remove_dir_all(&sibling_dir).await;
    }
    if let Ok(mut remaining) = tokio::fs::read_dir(dir).await {
        if matches!(remaining.next_entry().await, Ok(None)) {
            let _ = tokio::fs::remove_dir(dir).await;
        }
    }
}
