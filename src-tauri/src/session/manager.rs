// Port of `src/main/SessionManager.ts` (tasks.md T023): owns `store::registry` + `store::settings`,
// the live `agents: HashMap<SessionId, SessionAgent>` map, `summaries()` (completing `sessions.
// list`'s registry-only placeholder Phase 2(b) left with live-runtime fields), `get_or_create_
// agent`, `set_visible`, and `stop_all` (the app-exit path, `lib.rs`'s `ExitRequested` handler).
//
// The event fan-out itself (`src/main/ipc/register.ts`'s own `forwardEvent`) is not a separate
// listener loop here the way it is in TS (`SessionManager.onEvent`/`EventEmitter`): each
// `SessionAgent` already holds its own `events::EventSink` clone and calls it directly, since
// Rust has no single-process-wide event bus to subscribe a second listener to without adding one
// (see `events.rs`'s own doc comment). `SessionManager` itself only owns the `visible_ids` set
// every agent's `EventSink`-backed patch coalescer reads to decide whether to forward a patch.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};

use serde_json::Value;

use crate::events::EventSink;
use crate::git::worktree_validity::{
    list_registered_worktrees, registered_validity, WorktreeValidity,
};
use crate::session::agent::{SharedRegistry, SharedSettings};
use crate::session::SessionAgent;
use crate::store::registry::Repository;

/// Owns every live `SessionAgent` (one per Session opened this run) plus the shared registry/
/// settings stores every agent and every registry-only IPC handler already uses.
pub struct SessionManager {
    pub registry: SharedRegistry,
    pub settings: SharedSettings,
    events: EventSink,
    agents: StdMutex<HashMap<String, Arc<SessionAgent>>>,
    visible_ids: Arc<StdMutex<HashSet<String>>>,
}

/// Gate round 1 HIGH perf finding (#826): at most this many repositories' `git worktree list
/// --porcelain` calls run concurrently when `summaries()` needs to check several repositories'
/// no-live-agent Sessions at once. Unbounded concurrency here would still spike `git`/antivirus-
/// scanner load the same way the old per-Session loop did, just across repositories instead of
/// Sessions.
const WORKTREE_LIST_CONCURRENCY: usize = 4;

/// Gate round 1 HIGH perf finding: the old no-live-agent branch in `summaries()` called
/// `worktree_is_valid` (and so ran `git worktree list --porcelain`) once PER SESSION, serially,
/// with no concurrency cap and no timeout -- a repository with many Sessions re-listed the SAME
/// repository's worktrees over and over, and a single hung `git` could block the whole
/// `sessions.list` response. This issues `list_registered_worktrees` at most once per DISTINCT
/// repository id in `repo_ids` (each call already bounded by its own ~3s timeout, see
/// `worktree_validity.rs`), capped at `WORKTREE_LIST_CONCURRENCY` concurrent calls. A repository
/// id with no matching `Repository` row is silently skipped: `summaries()`'s own per-Session
/// loop already treats that case as `Invalid` directly, with no repository to even ask git
/// about.
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
        Arc::new(Self {
            registry,
            settings,
            events,
            agents: StdMutex::new(HashMap::new()),
            visible_ids: Arc::new(StdMutex::new(HashSet::new())),
        })
    }

    pub fn get_agent(&self, session_id: &str) -> Option<Arc<SessionAgent>> {
        self.agents
            .lock()
            .expect("agents mutex poisoned")
            .get(session_id)
            .cloned()
    }

    /// Every live `SessionAgent` this run, a snapshot clone (lane RM, issue #740: the role-
    /// change propagation sweep below needs to touch each one without holding the `agents`
    /// lock across an `.await`).
    pub fn live_agents(&self) -> Vec<Arc<SessionAgent>> {
        self.agents
            .lock()
            .expect("agents mutex poisoned")
            .values()
            .cloned()
            .collect()
    }

    /// Issue #740 (lane RM): called by `ipc::model_roles::model_roles_set` after a role's
    /// config value changes, AWAITED before that IPC call replies (gate-fix: an earlier
    /// comment/PR-body wording implied this runs "off the reply path" -- it does not; only the
    /// sweep's OWN work across Sessions is concurrent and bounded, the whole sweep still
    /// completes before `modelRoles.set`'s response is sent). Moves every live, non-pinned,
    /// non-stopped Session whose tracked role is `role` onto its freshly-resolved model --
    /// immediately if idle (concurrently, bounded, gate-fix MEDIUM/perf), queued for its own
    /// next settle if working (Stuart's decision, 2026-10-13: "automatic at the next idle
    /// moment", no prompt, never refused); a Session pinned by `/switch`/the composer picker
    /// (#454) is skipped. A Session with NO entry at all in `self.agents` (never opened or
    /// probed this run) is invisible to `live_agents()` and so is not counted in ANY bucket --
    /// it simply resumes its own saved model on its own next start. A Session that DOES have an
    /// agent entry (e.g. a prior open, or a `model.listRoles` probe) but whose live status is
    /// `Stopped` lands in `skipped_stopped` instead, rather than being counted as failed
    /// (gate-fix, HIGH/tests).
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
        // Gate-fix (round 10, MEDIUM): the caller already read this map in its own
        // `set_model_role` write -- re-reading raced a second `modelRoles.set` mid-sweep.
        // Shared via `Arc` for cheap cloning across every spawned task below. `stale_retry`
        // (round 11): a shared `OnceCell`, so at most ONE re-read happens for the WHOLE sweep
        // if a cached-map mismatch fires, not one per mismatching Session.
        let shared_model_roles = Arc::new(model_roles);
        let stale_retry: Arc<tokio::sync::OnceCell<std::collections::HashMap<String, String>>> =
            Arc::new(tokio::sync::OnceCell::new());
        // Gate-fix (MEDIUM, perf): idle Sessions are applied concurrently, bounded, instead of
        // one at a time -- each makes up to three RPCs, so a serial sweep's worst case grows
        // with the Session count.
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

            // Gate-fix (MEDIUM): check which role this Session is ON before checking whether it
            // is Stopped, not the other way around -- checking Stopped first put EVERY Stopped
            // Session in `skipped_stopped` for ANY role change, including one it was never on.
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
            // Atomic with the status read above being stale by now is fine: this re-checks
            // `status` itself (gate-fix, HIGH, race) and sets `pending_role_reapply` under the
            // SAME lock acquisition, so a settle landing in the gap can never lose the reapply.
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
                        // Gate-fix (MEDIUM): became working between the atomic
                        // queue-or-ready check and this task's own `send_if_idle` call.
                        // Re-run the SAME atomic decision now instead of waiting for the
                        // sequential loop to notice minutes later.
                        if agent.queue_role_reapply_or_ready(&role).await {
                            RoleApplyOutcome::Queued
                        } else {
                            match apply_role_now(&agent, &role, true, roles_ref, retry).await {
                                Ok(_) => RoleApplyOutcome::Moved,
                                Err(err2) if err2.code == "not-idle" => {
                                    // Gate-fix (round 6, HIGH): became working again between the
                                    // ready-check above and this retry's own send -- OMP is
                                    // still mid-turn even though Refract's OWN status already
                                    // looked idle. `queue_role_reapply_or_ready` does NOT set
                                    // `pending_role_reapply` for a `false` result, so if THIS
                                    // retry also failed not-idle, set it directly ourselves --
                                    // never report `Queued` unless something is actually queued.
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
                    // Gate-fix (MEDIUM): a panicked task used to be silently dropped, with the
                    // affected Session absent from every bucket and the Settings page none the
                    // wiser.
                    log::error!("apply_role_change: a role-reapply task panicked: {join_err}");
                }
            }
        }
        summary
    }

    /// `SessionManager.ts`'s own `getOrCreateAgent`: a brand-new instance on first access,
    /// returning the existing one for every later call -- never starts it (callers start a
    /// `stopped` agent explicitly).
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
        agents.insert(session_id.to_string(), agent.clone());
        agent
    }

    pub fn notify_list_changed(&self) {
        self.events.emit_session_list_changed();
    }

    pub fn emit_settings_changed(&self, settings: &Value) {
        self.events.emit_settings_changed(settings);
    }

    /// Lane R11b (issue #794): pass-throughs so `ipc::readiness`/`ipc::updates` (and `lib.rs`'s
    /// own install-on-quit/startup hooks) can broadcast without reaching into `events::EventSink`
    /// directly -- the same shape every other IPC-triggered broadcast in this file already uses.
    pub fn emit_readiness_install_progress(&self, progress: &Value) {
        self.events.emit_readiness_install_progress(progress);
    }

    pub fn emit_readiness_changed(&self, readiness: &Value) {
        self.events.emit_readiness_changed(readiness);
    }

    pub fn emit_updates_state_changed(&self, state: &Value) {
        self.events.emit_updates_state_changed(state);
    }

    /// `sessions.list()`'s live-runtime fields, merged over the registry-only `Session` row
    /// (data-model.md: "absent until the first `get_state`" for a Session with no agent this
    /// run, matching `SessionManager.summaries()`'s own no-runtime branch exactly). Lane R3
    /// (issue #786, gate-fix): `terminatedUnexpectedly`/`pendingToolNames` are now derived for
    /// every `stopped` row here, not left permanently absent -- a FRESH
    /// `resolve_termination()`/`resolve_termination_for` call either way, same as `ipc::
    /// sessions_agent`'s own attach/resume paths, so a list row's own crash badge is correct
    /// even for a Session nothing has opened yet this run.
    pub async fn summaries(&self) -> Vec<Value> {
        let snapshot = self.registry.lock().await.snapshot();
        let sessions = snapshot.sessions;
        let repositories = snapshot.repositories;
        let launched_mode = serde_json::to_value(self.settings.lock().await.get().approval_mode)
            .expect("ApprovalMode is always JSON-serialisable");

        // Gate round 1 HIGH perf finding (#826): collect the distinct repository ids actually
        // needed (every Session with no live agent) BEFORE touching git at all, so the `git
        // worktree list` fetch below runs once per repository, not once per Session.
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
                    // Issue #729 (lane R2, #785): registered with git AND has its own `.git`
                    // pointer, not merely `fs::metadata` succeeding -- a hand-emptied or
                    // orphaned-but-still-present folder both satisfied the old `exists()` check
                    // while being unusable. Gate round 1 (#826): the repository's registered-
                    // worktree list was already fetched once above (`fetch_worktree_lists`), so
                    // this is a cheap local `.git` stat plus a lookup, no `git` process per
                    // Session.
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
                    // Gate round 1: a timed-out registry check must never read as a confirmed-
                    // missing worktree (a slow disk/antivirus scan is not proof the worktree is
                    // gone) -- `Unknown` is mapped the SAME as `Valid` here, optimistically
                    // assuming the worktree is still there rather than reporting the harsher
                    // `worktree-missing` on a mere timeout.
                    let stop_reason = match validity {
                        WorktreeValidity::Valid | WorktreeValidity::Unknown => "not-started",
                        WorktreeValidity::Invalid => "worktree-missing",
                    };
                    object.insert("status".to_string(), Value::String("stopped".to_string()));
                    object.insert(
                        "stopReason".to_string(),
                        Value::String(stop_reason.to_string()),
                    );
                    object.insert("unread".to_string(), Value::Bool(false));
                    object.insert("launchedMode".to_string(), launched_mode.clone());
                    object.insert("pendingMode".to_string(), Value::Null);
                }
            }
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

    /// `sessions.delete` (issue #785, lane R2): drops the live agent from the map once its
    /// Session is removed from the registry, so a later `get_or_create_agent` call for the same
    /// (now-deleted) id can never resurrect a process over a worktree `sessions.delete` just
    /// removed. Callers stop the agent (`shutdown()`) themselves first; this only forgets it.
    pub fn remove_agent(&self, session_id: &str) {
        self.agents
            .lock()
            .expect("agents mutex poisoned")
            .remove(session_id);
    }

    /// `sessions.setVisible` (T036/T037, spec 005 Decision 2): selects which Sessions' patches
    /// are forwarded (`SessionAgent`'s own `PatchCoalescer` flush closure reads `visible_ids`
    /// directly). For each NEWLY-visible Session, clears `unread` and flushes a full transcript
    /// snapshot (`emit_patch_reset`) -- its patches were silently dropped by the coalescer's own
    /// gate while hidden, so the renderer needs a full catch-up snapshot the moment it becomes
    /// visible, exactly as the single-id form already did.
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

    /// Stops every live agent concurrently (`lib.rs`'s `RunEvent::ExitRequested` handler, port
    /// of `src/main/index.ts`'s own `before-quit` stop-all).
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
        let dir = std::env::temp_dir().join(format!(
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
            current_turn_subagents: None,
            stopped_on_request_conversation: None,
            stopped_on_request_at_size: None,
        }
    }

    /// Gate round 1 HIGH perf finding (#826): proves `summaries()`'s batched per-repository
    /// worktree check (`fetch_worktree_lists`) still reports the right `stopReason` for every
    /// Session in a repository with 3 registry-only Sessions sharing it -- one healthy, one
    /// with its `.git` pointer hand-deleted, one whose worktree folder was removed entirely
    /// (the same three states the old per-Session `worktree_is_valid` call covered). The
    /// call-count claim itself ("once per repository, not once per Session") is enforced by
    /// this file's own structure, not re-proved here: `fetch_worktree_lists` calls
    /// `list_registered_worktrees` exactly once per distinct repository id in its `repo_ids`
    /// slice (see its own doc comment) -- all 3 Sessions below share that one repository id, so
    /// this test is proving the single shared fetch result was looked up correctly for all
    /// three, not silently re-fetched or mixed up between Sessions.
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
