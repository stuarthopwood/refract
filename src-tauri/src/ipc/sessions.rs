// IPC handlers for `sessions.*` (contracts/ipc.md "Sessions", tasks.md T019/T024). `.list`/
// `.create`/`.rename` are the registry-only subset (Phase 2(b)); `.list` now completes its
// live-runtime fields via `session::SessionManager::summaries` (Phase 3, tasks.md T024) instead
// of the "never opened this run" default placeholder. `.open`/`.stopAgent`/`.setVisible` (Phase
// 3, tasks.md T024) dispatch into the live `session::SessionManager` `AppState::session_manager`
// carries.

use serde_json::Value;

use crate::git::worktrees::{add_worktree, generate_name, list_branches, remove_worktree};
use crate::store::registry::Session;

use super::{
    invalid_argument, map_git_error, map_registry_error, not_found, now_iso8601, AppState,
    HandlerFuture,
};

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

/// `sessions.open` (T024): auto-starts a `stopped` Session when nothing is wrong with the agent
/// itself (port of `ipc/canAutoStart.ts`'s own `canAutoStart`, simplified: `terminatedUnexpectedly`
/// is always `false` in this build, see `session::agent`'s own header, so this reduces to
/// "`stopReason` is absent, `not-started`, or `worktree-missing`"). `userAction` (issue #509
/// quality-gate fix) bypasses this gate outright -- a user explicitly sending a message to a
/// not-yet-opened pane must still start the agent.
pub fn sessions_open(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let Some(id) = args.first().and_then(Value::as_str).map(str::to_string) else {
            return Err(invalid_argument("sessions.open expects a string id"));
        };
        let user_action = args.get(1).and_then(Value::as_bool).unwrap_or(false);
        if state.registry.lock().await.get_session(&id).is_none() {
            return Err(not_found(format!("Session not found: {id}")));
        }
        let agent = state.session_manager.get_or_create_agent(&id);
        if agent.status().await == crate::session::SessionStatus::Stopped {
            let runtime = agent.runtime_view().await;
            let stop_reason = runtime
                .get("stopReason")
                .and_then(Value::as_str)
                .map(str::to_string);
            let can_auto_start = user_action
                || matches!(
                    stop_reason.as_deref(),
                    None | Some("not-started") | Some("worktree-missing")
                );
            if can_auto_start {
                let _ = agent.start().await;
                state.session_manager.notify_list_changed();
            }
        }
        let session = state
            .registry
            .lock()
            .await
            .get_session(&id)
            .cloned()
            .ok_or_else(|| not_found(format!("Session not found: {id}")))?;
        Ok(super::conversations::build_snapshot(&session, &agent).await)
    })
}

/// `sessions.stopAgent` (T040): closes stdin, awaits a graceful exit, then force-kills via the
/// Job Object's owning process tree (`OmpProcess::stop`, FR-004).
pub fn sessions_stop_agent(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let Some(id) = args.first().and_then(Value::as_str) else {
            return Err(invalid_argument(
                "sessions.stopAgent expects a string sessionId",
            ));
        };
        if state.registry.lock().await.get_session(id).is_none() {
            return Err(not_found(format!("Session not found: {id}")));
        }
        state
            .session_manager
            .get_or_create_agent(id)
            .shutdown()
            .await;
        Ok(Value::Null)
    })
}

/// `sessions.setVisible` (T036/T037, spec 005 Decision 2): at most two session ids (a single
/// pane, or a split).
pub fn sessions_set_visible(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let Some(array) = args.first().and_then(Value::as_array) else {
            return Err(invalid_argument(
                "sessions.setVisible expects an array of at most 2 session ids",
            ));
        };
        if array.len() > 2 {
            return Err(invalid_argument(
                "sessions.setVisible expects an array of at most 2 session ids",
            ));
        }
        let mut ids = Vec::with_capacity(array.len());
        for entry in array {
            let Some(id) = entry.as_str() else {
                return Err(invalid_argument(
                    "sessions.setVisible expects an array of at most 2 session ids",
                ));
            };
            ids.push(id.to_string());
        }
        state.session_manager.set_visible(ids).await;
        Ok(Value::Null)
    })
}
