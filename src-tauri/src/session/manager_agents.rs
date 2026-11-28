// The aggregated `agents:update` for the Agents panel: every live Session's subagents in one
// coalesced push, so a hidden Session reaches the panel without being on screen.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde_json::{json, Map, Value};

use crate::session::subagents::{current_summaries_value, SUMMARIES_COALESCE_MS};
use crate::session::{SessionManager, SessionStatus};

/// The one pending-emit flag; the groups themselves are read from the live agents at emit time.
#[derive(Default)]
pub(super) struct AgentsAggregate {
    pending: AtomicBool,
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
            let groups = manager.agents_snapshot().await;
            manager.events.emit_agents_update(groups);
        });
    }

    /// One group per live, unarchived, non-stopped Session that has subagents to show, ordered by
    /// Session id. The payload is a full replacement, so a Session missing from it has dropped out.
    pub(crate) async fn agents_snapshot(&self) -> Value {
        let mut groups = Vec::new();
        for agent in self.live_agents() {
            if agent.status().await == SessionStatus::Stopped {
                continue;
            }
            let subagents = current_summaries_value(&agent).await;
            if subagents.as_array().is_none_or(Vec::is_empty) {
                continue;
            }
            let mut group = Map::new();
            {
                let registry = self.registry.lock().await;
                let Some(session) = registry.get_session(agent.session_id()) else {
                    continue;
                };
                if session.archived_at.is_some() {
                    continue;
                }
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
            }
            group.insert("status".into(), json!(agent.status().await));
            group.insert("subagents".into(), subagents);
            groups.push(Value::Object(group));
        }
        groups.sort_by(|a, b| a["sessionId"].as_str().cmp(&b["sessionId"].as_str()));
        Value::Array(groups)
    }
}
