// IPC handlers for the registry-only `sessions.*` subset (contracts/ipc.md "Sessions", tasks.md
// T019/T024): `.list`/`.create`/`.rename` (Phase 2(b)). `.list` now completes its live-runtime
// fields via `session::SessionManager::summaries` (Phase 3, tasks.md T024) instead of the "never
// opened this run" default placeholder.
//
// Split from the former `ipc/sessions.rs` (issue #784, "Pre-declare per-lane Rust files") so
// lane R2 (#785, session worktree and lifecycle: archive, restore, delete, recreate, diffStat,
// reveal, remotes) is the only lane that ever edits this file; `.open`/`.stopAgent`/
// `.setVisible` live in the sibling `ipc/sessions_agent.rs` instead (lane R3, #786).

use serde_json::Value;

use crate::git::worktrees::{add_worktree, generate_name, list_branches, remove_worktree};
use crate::store::registry::Session;

use super::{
    invalid_argument, map_git_error, map_registry_error, not_found, now_iso8601, AppState,
    Dispatcher, HandlerFuture,
};

pub fn register(d: &mut Dispatcher) {
    d.register("sessions.list", sessions_list);
    d.register("sessions.create", sessions_create);
    d.register("sessions.rename", sessions_rename);
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

        let name = generate_name(repo_path).await.map_err(map_git_error)?;
        let added = add_worktree(repo_path, &name, &base_branch)
            .await
            .map_err(map_git_error)?;
        let now = now_iso8601();
        let session = Session {
            id: uuid::Uuid::new_v4().to_string(),
            repository_id: repository_id.clone(),
            name,
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
            // been removed while `list_branches`/`generate_name`/`add_worktree` above were still
            // in flight -- roll back the worktree/branch just created so it is not stranded.
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
