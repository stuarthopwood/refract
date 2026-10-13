// IPC handlers for `sessions.*` (contracts/ipc.md "Sessions", tasks.md T019). Only the
// registry-only subset is ported here: `.list` (the registry-only half -- live-runtime fields
// left at their "never opened this run" default, matching `SessionManager.summaries()`'s own
// no-runtime branch exactly, data-model.md), `.create`, and `.rename`. `.open`/`.stopAgent`/
// `.setVisible` are deliberately NOT registered -- each needs the live `session::manager` Phase 3
// provides (this slice's own assignment: sequence the registry-only arms ahead of the
// agent-backed ones, matching tasks.md T019's own ordering note).

use serde_json::Value;

use crate::git::worktrees::{add_worktree, generate_name, list_branches, remove_worktree};
use crate::store::registry::Session;

use super::{invalid_argument, map_git_error, map_registry_error, not_found, now_iso8601, AppState, HandlerFuture};

pub fn sessions_list(state: AppState, _args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let sessions = state.registry.lock().await.snapshot().sessions;
        let launched_mode = state.settings.lock().await.get().approval_mode;
        let launched_mode_value = serde_json::to_value(launched_mode).expect("ApprovalMode is always JSON-serialisable");

        let mut summaries = Vec::with_capacity(sessions.len());
        for session in &sessions {
            let worktree_exists = tokio::fs::metadata(&session.worktree_path).await.is_ok();
            let stop_reason = if worktree_exists { "not-started" } else { "worktree-missing" };
            let mut summary = serde_json::to_value(session).expect("Session is always JSON-serialisable");
            let object = summary.as_object_mut().expect("Session serialises to a JSON object");
            object.insert("status".to_string(), Value::String("stopped".to_string()));
            object.insert("stopReason".to_string(), Value::String(stop_reason.to_string()));
            object.insert("unread".to_string(), Value::Bool(false));
            object.insert("launchedMode".to_string(), launched_mode_value.clone());
            object.insert("pendingMode".to_string(), Value::Null);
            // `terminatedUnexpectedly` is left absent: computing it needs `detectUnexpectedTermination`'s
            // own Conversation-tail read (`omp/terminationDetection.ts`), which depends on the
            // transcript port (Phase 2(c), a concurrent sibling slice) -- absent is the documented
            // default for a Session this run has not touched, same as every other live-runtime field.
            summaries.push(summary);
        }
        Ok(Value::Array(summaries))
    })
}

pub fn sessions_create(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let input = match args.first().and_then(Value::as_object) {
            Some(input) => input,
            None => return Err(invalid_argument("sessions.create expects { repositoryId, baseBranch }")),
        };
        let repository_id = match input.get("repositoryId").and_then(Value::as_str) {
            Some(id) => id.to_string(),
            None => return Err(invalid_argument("sessions.create expects { repositoryId: string, baseBranch: string }")),
        };
        let base_branch = match input.get("baseBranch").and_then(Value::as_str) {
            Some(branch) => branch.to_string(),
            None => return Err(invalid_argument("sessions.create expects { repositoryId: string, baseBranch: string }")),
        };

        let repository = {
            let registry = state.registry.lock().await;
            registry.get_repository(&repository_id).ok_or_else(|| not_found(format!("Repository not found: {repository_id}")))?.clone()
        };
        let repo_path = std::path::Path::new(&repository.path);

        let branches = list_branches(repo_path).await.map_err(map_git_error)?;
        if !branches.iter().any(|b| b == &base_branch) {
            return Err(super::IpcError::new("base-missing", format!("Base branch not found: {base_branch}")));
        }

        let name = generate_name(repo_path).await.map_err(map_git_error)?;
        let added = add_worktree(repo_path, &name, &base_branch).await.map_err(map_git_error)?;
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

        if let Err(err) = state.registry.lock().await.add_session(session.clone()).await {
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
            None => return Err(invalid_argument("sessions.rename expects (id, name) strings")),
        };
        let name = match args.get(1).and_then(Value::as_str) {
            Some(name) => name.to_string(),
            None => return Err(invalid_argument("sessions.rename expects (id, name) strings")),
        };
        state.registry.lock().await.update_session_name(&id, name).await.map_err(map_registry_error)?;
        Ok(Value::Null)
    })
}
