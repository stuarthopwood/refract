// The aggregated `agents:update` for the Agents panel: every live Session's subagents in one
// coalesced push, so a hidden Session reaches the panel without being on screen.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde_json::{json, Map, Value};

use crate::session::subagents::{current_summaries_value, SUMMARIES_COALESCE_MS};
use crate::session::{SessionManager, SessionStatus};

/// The one pending-emit flag plus the last payload sent; the groups themselves are read from the
/// live agents at emit time.
#[derive(Default)]
pub(super) struct AgentsAggregate {
    pending: AtomicBool,
    /// Held across snapshot and emit, so two overlapping windows cannot deliver out of order, and
    /// so an unchanged snapshot is not pushed again.
    last_emitted: tokio::sync::Mutex<Option<Value>>,
}

impl SessionManager {
    /// Queues one `agents:update` a coalescing window from now; further calls inside the window share it.
    /// Called on every subagent change, status change, archive and delete, so a drop is pushed too.
    pub(crate) fn schedule_agents_update(&self) {
        if self.agents_aggregate.pending.swap(true, Ordering::AcqRel) {
            return;
        }
        let spawned = tokio::runtime::Handle::try_current()
            .ok()
            .zip(self.self_ref.upgrade());
        let Some((runtime, manager)) = spawned else {
            self.agents_aggregate
                .pending
                .store(false, Ordering::Release);
            return;
        };
        runtime.spawn(async move {
            tokio::time::sleep(Duration::from_millis(SUMMARIES_COALESCE_MS)).await;
            // Cleared before reading, so a change landing mid-read queues the next window.
            manager
                .agents_aggregate
                .pending
                .store(false, Ordering::Release);
            let mut last = manager.agents_aggregate.last_emitted.lock().await;
            let groups = manager.agents_snapshot().await;
            if last.as_ref() == Some(&groups) {
                return;
            }
            *last = Some(groups.clone());
            manager.events.emit_agents_update(groups);
        });
    }

    /// One group per live, unarchived, non-stopped Session that has subagents to show, ordered by
    /// Session id. The payload is a full replacement, so a Session missing from it has dropped out.
    pub(crate) async fn agents_snapshot(&self) -> Value {
        // Status and subagents are read from each agent first, so the registry lock is taken once
        // and never held across an agent's own locks.
        let mut live = Vec::new();
        for agent in self.live_agents() {
            let status = agent.status().await;
            if status == SessionStatus::Stopped {
                continue;
            }
            let subagents = current_summaries_value(&agent).await;
            if subagents.as_array().is_none_or(Vec::is_empty) {
                continue;
            }
            live.push((agent.session_id().to_string(), status, subagents));
        }
        let mut groups = Vec::new();
        {
            let registry = self.registry.lock().await;
            for (session_id, status, subagents) in live {
                let Some(session) = registry.get_session(&session_id) else {
                    continue;
                };
                if session.archived_at.is_some() {
                    continue;
                }
                let mut group = Map::new();
                group.insert("sessionId".into(), json!(session.id));
                group.insert("name".into(), json!(session.name));
                let repository = session
                    .repository_id
                    .as_deref()
                    .and_then(|id| registry.get_repository(id));
                if let Some(repository) = repository {
                    group.insert("repositoryId".into(), json!(repository.id));
                    group.insert("repositoryName".into(), json!(repository.name));
                }
                group.insert("status".into(), json!(status));
                group.insert("subagents".into(), subagents);
                groups.push(Value::Object(group));
            }
        }
        groups.sort_by(|a, b| a["sessionId"].as_str().cmp(&b["sessionId"].as_str()));
        Value::Array(groups)
    }
}

#[cfg(test)]
impl SessionManager {
    /// Test seam: gives the Session's agent one running subagent, so it has a group.
    pub(crate) async fn seed_agents_group(&self, session_id: &str) {
        let agent = self.get_or_create_agent(session_id);
        crate::session::subagents::test_support::seed_running_subagent(&agent).await;
    }
}
