// Owns the live `SessionAgent` map and the registry-backed session summaries.

use crate::events::EventSink;
use crate::git::worktree_validity::{
    list_registered_worktrees, registered_validity, WorktreeValidity,
};
use crate::session::agent::{SharedRegistry, SharedSettings};
use crate::session::SessionAgent;
use crate::store::registry::Repository;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};

/// Owns every live `SessionAgent` and the shared registry and settings stores.
pub struct SessionManager {
    pub registry: SharedRegistry,
    pub settings: SharedSettings,
    events: EventSink,
    agents: StdMutex<HashMap<String, Arc<SessionAgent>>>,
    visible_ids: Arc<StdMutex<HashSet<String>>>,
    self_ref: std::sync::Weak<SessionManager>,
}

/// Caps concurrent `git worktree list` calls across repositories.
/// Unbounded concurrency would spike git and antivirus load.
const WORKTREE_LIST_CONCURRENCY: usize = 4;

/// Lists each distinct repository's worktrees once, not once per Session.
/// Each call has its own timeout, and a repository id with no row is skipped.
async fn fetch_worktree_lists(
    repo_ids: &[String],
    repositories: &[Repository],
) -> HashMap<String, Option<Vec<String>>> {
    let semaphore = Arc::new(tokio::sync::Semaphore::new(WORKTREE_LIST_CONCURRENCY));
    let mut handles = Vec::with_capacity(repo_ids.len());
    for repo_id in repo_ids {
        let Some(repository) = repositories.iter().find(|r| &r.id == repo_id) else {
            continue;
        };
        let repo_path = PathBuf::from(&repository.path);
        let repo_id = repo_id.clone();
        let semaphore = semaphore.clone();
        handles.push(tokio::spawn(async move {
            let _permit = semaphore
                .acquire_owned()
                .await
                .expect("semaphore is never closed");
            let list = list_registered_worktrees(&repo_path).await;
            (repo_id, list)
        }));
    }
    let mut out = HashMap::with_capacity(handles.len());
    for handle in handles {
        if let Ok((repo_id, list)) = handle.await {
            out.insert(repo_id, list);
        }
    }
    out
}

impl SessionManager {
    pub fn new(registry: SharedRegistry, settings: SharedSettings, events: EventSink) -> Arc<Self> {
        Arc::new_cyclic(|self_ref| Self {
            registry,
            settings,
            events,
            agents: StdMutex::new(HashMap::new()),
            visible_ids: Arc::new(StdMutex::new(HashSet::new())),
            self_ref: self_ref.clone(),
        })
    }

    pub fn get_agent(&self, session_id: &str) -> Option<Arc<SessionAgent>> {
        self.agents
            .lock()
            .expect("agents mutex poisoned")
            .get(session_id)
            .cloned()
    }

    /// Every live `SessionAgent`, as a snapshot clone taken without holding the lock.
    pub fn live_agents(&self) -> Vec<Arc<SessionAgent>> {
        self.agents
            .lock()
            .expect("agents mutex poisoned")
            .values()
            .cloned()
            .collect()
    }

    /// Moves each live, unpinned Session on `role` to its new model: now if idle, else at its next idle.
    /// A Session with no agent entry is not counted, and resumes its saved model on next start.
    pub async fn apply_role_change(
        &self,
        role: &str,
        model_roles: std::collections::HashMap<String, String>,
    ) -> crate::session::model::RoleChangeSummary {
        use crate::session::model::{apply_role_now, current_selection, RoleChangeSummary};
        use crate::session::SessionStatus;

        enum RoleApplyOutcome {
            Moved,
            Queued,
            Failed,
        }

        let mut summary = RoleChangeSummary::default();
        // Shared via `Arc` so every spawned task can clone it cheaply.
        let shared_model_roles = Arc::new(model_roles);
        let stale_retry: Arc<tokio::sync::OnceCell<std::collections::HashMap<String, String>>> =
            Arc::new(tokio::sync::OnceCell::new());
        // Idle Sessions are applied concurrently and bounded, not one at a time.
        const CONCURRENCY: usize = 4;
        let semaphore = Arc::new(tokio::sync::Semaphore::new(CONCURRENCY));
        let mut idle_tasks = Vec::new();

        for agent in self.live_agents() {
            let name = self
                .registry
                .lock()
                .await
                .get_session(agent.session_id())
                .map(|s| s.name.clone())
                .unwrap_or_else(|| agent.session_id().to_string());

            // Check the role before Stopped, so Stopped Sessions on other roles are not skipped.
            let (pinned, current_role) = current_selection(&agent).await;
            let effective = current_role.as_deref().unwrap_or("default");
            if effective != role {
                continue;
            }
            if agent.status().await == SessionStatus::Stopped {
                summary.skipped_stopped.push(name);
                continue;
            }
            if pinned {
                summary.skipped_pinned.push(name);
                continue;
            }
            // Re-checks `status` under the same lock that sets `pending_role_reapply`, so no settle is lost.
            if agent.queue_role_reapply_or_ready(role).await {
                summary.queued.push(name);
                continue;
            }
            let semaphore = semaphore.clone();
            let role = role.to_string();
            let shared_model_roles = shared_model_roles.clone();
            let stale_retry = stale_retry.clone();
            idle_tasks.push(tokio::spawn(async move {
                let _permit = semaphore
                    .acquire_owned()
                    .await
                    .expect("semaphore never closed");
                let roles_ref = Some(shared_model_roles.as_ref());
                let retry = Some(stale_retry.as_ref());
                let outcome = match apply_role_now(&agent, &role, true, roles_ref, retry).await {
                    Ok(_) => RoleApplyOutcome::Moved,
                    Err(err) if err.code == "not-idle" => {
                        // Became working after the ready check; re-run the same atomic decision.
                        if agent.queue_role_reapply_or_ready(&role).await {
                            RoleApplyOutcome::Queued
                        } else {
                            match apply_role_now(&agent, &role, true, roles_ref, retry).await {
                                Ok(_) => RoleApplyOutcome::Moved,
                                Err(err2) if err2.code == "not-idle" => {
                                    // Still mid-turn after the retry failed, so queue it directly.
                                    if !agent.queue_role_reapply_or_ready(&role).await {
                                        agent
                                            .with_model_state(|s| {
                                                if s.pending_role_reapply.is_none() {
                                                    s.pending_role_reapply = Some(role.clone());
                                                }
                                            })
                                            .await;
                                    }
                                    RoleApplyOutcome::Queued
                                }
                                Err(_) => RoleApplyOutcome::Failed,
                            }
                        }
                    }
                    Err(_) => RoleApplyOutcome::Failed,
                };
                (name, outcome)
            }));
        }
        for task in idle_tasks {
            match task.await {
                Ok((name, RoleApplyOutcome::Moved)) => summary.moved.push(name),
                Ok((name, RoleApplyOutcome::Queued)) => summary.queued.push(name),
                Ok((name, RoleApplyOutcome::Failed)) => summary.failed.push(name),
                Err(join_err) => {
                    // A panicked task is reported, not dropped from every bucket.
                    log::error!("apply_role_change: a role-reapply task panicked: {join_err}");
                }
            }
        }
        summary
    }

    /// Returns the existing agent, or creates one on first access. Never starts it.
    pub fn get_or_create_agent(&self, session_id: &str) -> Arc<SessionAgent> {
        let mut agents = self.agents.lock().expect("agents mutex poisoned");
        if let Some(existing) = agents.get(session_id) {
            return existing.clone();
        }
        let agent = SessionAgent::new(
            session_id.to_string(),
            self.registry.clone(),
            self.settings.clone(),
            self.events.clone(),
            self.visible_ids.clone(),
        );
        agent.attach_manager(self.self_ref.clone());
        agents.insert(session_id.to_string(), agent.clone());
        agent
    }

    pub fn notify_list_changed(&self) {
        self.events.emit_session_list_changed();
    }

    pub fn emit_session_deleted(&self, session_id: &str) {
        self.events.emit_session_deleted(session_id);
    }

    pub fn emit_session_delete_failed(&self, session_id: &str, code: &str, message: &str) {
        self.events
            .emit_session_delete_failed(session_id, code, message);
    }

    pub fn emit_settings_changed(&self, settings: &Value) {
        self.events.emit_settings_changed(settings);
    }

    /// Pass-throughs so IPC and startup hooks broadcast without touching `EventSink` directly.
    pub fn emit_readiness_install_progress(&self, progress: &Value) {
        self.events.emit_readiness_install_progress(progress);
    }

    pub fn emit_readiness_changed(&self, readiness: &Value) {
        self.events.emit_readiness_changed(readiness);
    }

    pub fn emit_updates_state_changed(&self, state: &Value) {
        self.events.emit_updates_state_changed(state);
    }

    /// The registry's repositories and Sessions, for the Session tools.
    pub async fn registry_snapshot(&self) -> crate::store::registry::Registry {
        self.registry.lock().await.snapshot()
    }

    /// Merges live-runtime fields over the registry row. `stopped` rows get fresh termination info.
    pub async fn summaries(&self) -> Vec<Value> {
        let snapshot = self.registry.lock().await.snapshot();
        let sessions = snapshot.sessions;
        let repositories = snapshot.repositories;
        let launched_mode = serde_json::to_value(self.settings.lock().await.get().approval_mode)
            .expect("ApprovalMode is always JSON-serialisable");

        // Collect the needed repository ids first, so git runs once per repository.
        let mut repos_needed: Vec<String> = Vec::new();
        for session in &sessions {
            if self.get_agent(&session.id).is_some() {
                continue;
            }
            if !repos_needed.contains(&session.repository_id) {
                repos_needed.push(session.repository_id.clone());
            }
        }
        let worktree_lists = fetch_worktree_lists(&repos_needed, &repositories).await;

        let mut summaries = Vec::with_capacity(sessions.len());
        for session in &sessions {
            let mut summary =
                serde_json::to_value(session).expect("Session is always JSON-serialisable");
            let object = summary
                .as_object_mut()
                .expect("Session serialises to a JSON object");
            let agent = self.get_agent(&session.id);
            match &agent {
                Some(agent) => {
                    let live = agent.summary_fields().await;
                    for (key, value) in live
                        .as_object()
                        .expect("summary_fields is always a JSON object")
                    {
                        object.insert(key.clone(), value.clone());
                    }
                }
                None => {
                    // Valid only if registered with git and its own `.git` pointer exists.
                    let has_repository = repositories.iter().any(|r| r.id == session.repository_id);
                    let validity = if !has_repository {
                        WorktreeValidity::Invalid
                    } else {
                        let has_git_entry = tokio::fs::symlink_metadata(
                            Path::new(&session.worktree_path).join(".git"),
                        )
                        .await
                        .is_ok();
                        if !has_git_entry {
                            WorktreeValidity::Invalid
                        } else {
                            let registered = worktree_lists
                                .get(&session.repository_id)
                                .and_then(|list| list.as_deref());
                            registered_validity(Path::new(&session.worktree_path), registered).await
                        }
                    };
                    // A timed-out check is `Unknown`, treated as valid, not as missing.
                    let stop_reason = match validity {
                        WorktreeValidity::Valid | WorktreeValidity::Unknown => "not-started",
                        WorktreeValidity::Invalid => "worktree-missing",
                    };
                    object.insert("status".to_string(), Value::String("stopped".to_string()));
                    object.insert("stopReason".to_string(), stop_reason.into());
                    object.insert("unread".to_string(), Value::Bool(false));
                    object.insert("launchedMode".to_string(), launched_mode.clone());
                    object.insert("pendingMode".to_string(), Value::Null);
                    crate::session::agent::pause::mark_stopped(object, &session.paused_held);
                }
            }
            let activity = crate::session::readout::current_activity(agent.as_deref()).await;
            object.insert("activity".to_string(), activity);
            if object.get("status").and_then(Value::as_str) == Some("stopped") {
                let detection = match &agent {
                    Some(agent) => agent.resolve_termination().await,
                    None => {
                        crate::session::termination::resolve_termination_for(session, false).await
                    }
                };
                if detection.terminated_unexpectedly {
                    object.insert("terminatedUnexpectedly".to_string(), Value::Bool(true));
                    if !detection.pending_tool_names.is_empty() {
                        object.insert(
                            "pendingToolNames".to_string(),
                            serde_json::json!(detection.pending_tool_names),
                        );
                    }
                }
            }
            summaries.push(summary);
        }
        summaries
    }

    /// Drops the agent once its Session is deleted, so a later call cannot resurrect it.
    pub fn remove_agent(&self, session_id: &str) {
        self.agents
            .lock()
            .expect("agents mutex poisoned")
            .remove(session_id);
    }

    /// Sets which Sessions forward patches. A newly visible Session gets a full snapshot flush.
    pub async fn set_visible(&self, session_ids: Vec<String>) {
        let next: HashSet<String> = session_ids.into_iter().take(2).collect();
        let newly_visible: Vec<String> = {
            let mut guard = self.visible_ids.lock().expect("visible_ids mutex poisoned");
            let newly_visible: Vec<String> = next.difference(&guard).cloned().collect();
            *guard = next;
            newly_visible
        };
        for session_id in newly_visible {
            if let Some(agent) = self.get_agent(&session_id) {
                agent.clear_unread().await;
                agent.emit_patch_reset().await;
            }
        }
    }

    /// Stops every live agent concurrently, for the app-exit path.
    pub async fn stop_all(&self) {
        let agents: Vec<Arc<SessionAgent>> = self
            .agents
            .lock()
            .expect("agents mutex poisoned")
            .values()
            .cloned()
            .collect();
        let mut handles = Vec::with_capacity(agents.len());
        for agent in agents {
            handles.push(tokio::spawn(async move { agent.shutdown().await }));
        }
        for handle in handles {
            let _ = handle.await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_support::init_repo;
    use crate::git::worktrees::add_worktree_with_generated_name;
    use crate::store::registry::{RegistryStore, Session};
    use crate::store::settings::SettingsStore;
    use tokio::sync::Mutex as AsyncMutex;

    fn temp_dir(label: &str) -> std::path::PathBuf {
        let dir = crate::test_scratch::path(format!(
            "refract-session-manager-test-{label}-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn make_session(
        id: &str,
        repository_id: &str,
        worktree_path: &std::path::Path,
        branch: &str,
    ) -> Session {
        Session {
            id: id.to_string(),
            repository_id: repository_id.to_string(),
            name: "Test Session".to_string(),
            branch: branch.to_string(),
            base_branch: "main".to_string(),
            worktree_path: worktree_path.to_string_lossy().to_string(),
            session_dir: None,
            current_conversation: None,
            last_message_count: None,
            last_model: None,
            last_thinking_level: None,
            created_at: "2026-01-01T00:00:00.000Z".to_string(),
            last_activity_at: "2026-01-01T00:00:00.000Z".to_string(),
            archived_at: None,
            hidden_at: None,
            paused_held: None,
            current_turn_subagents: None,
            stopped_on_request_conversation: None,
            stopped_on_request_at_size: None,
            pinned_model: false,
            origin_issue: None,
            parent_session_id: None,
        }
    }

    /// Checks that batched worktree validity still reports the right `stopReason` per Session.
    /// Covers healthy, broken `.git`, and missing folder, all sharing one repository.
    #[tokio::test]
    async fn summaries_reports_the_right_stop_reason_for_every_session_sharing_one_repository() {
        let repo = init_repo().await;
        let healthy = add_worktree_with_generated_name(&repo, "main")
            .await
            .expect("create healthy worktree");
        let hand_emptied = add_worktree_with_generated_name(&repo, "main")
            .await
            .expect("create hand-emptied worktree");
        tokio::fs::remove_file(hand_emptied.worktree_path.join(".git"))
            .await
            .expect("remove .git pointer");
        let removed_worktree_path = repo.with_file_name("removed-worktree-does-not-exist");

        let dir = temp_dir("batched-validity");
        let mut registry_store = RegistryStore::open(&dir).await.expect("open registry");
        let repository = Repository {
            id: "repo-1".to_string(),
            path: repo.to_string_lossy().to_string(),
            name: "pinion".to_string(),
            default_branch: "main".to_string(),
            added_at: "2026-01-01T00:00:00.000Z".to_string(),
            color: None,
        };
        registry_store
            .add_repository(repository)
            .await
            .expect("add repository");
        registry_store
            .add_session(make_session(
                "healthy",
                "repo-1",
                &healthy.worktree_path,
                "healthy-branch",
            ))
            .await
            .expect("add healthy session");
        registry_store
            .add_session(make_session(
                "hand-emptied",
                "repo-1",
                &hand_emptied.worktree_path,
                "hand-emptied-branch",
            ))
            .await
            .expect("add hand-emptied session");
        registry_store
            .add_session(make_session(
                "removed",
                "repo-1",
                &removed_worktree_path,
                "removed-branch",
            ))
            .await
            .expect("add removed session");

        let registry = Arc::new(AsyncMutex::new(registry_store));
        let settings = Arc::new(AsyncMutex::new(
            SettingsStore::open(&dir).await.expect("open settings"),
        ));
        let app_handle_slot: Arc<StdMutex<Option<tauri::AppHandle>>> =
            Arc::new(StdMutex::new(None));
        let events = EventSink::new(app_handle_slot, registry.clone());
        let manager = SessionManager::new(registry, settings, events);

        let summaries = manager.summaries().await;
        let find = |id: &str| {
            summaries
                .iter()
                .find(|s| s["id"] == id)
                .unwrap_or_else(|| panic!("summary for {id} missing"))
        };
        assert_eq!(find("healthy")["stopReason"], "not-started");
        assert_eq!(find("hand-emptied")["stopReason"], "worktree-missing");
        assert_eq!(find("removed")["stopReason"], "worktree-missing");
    }
}
