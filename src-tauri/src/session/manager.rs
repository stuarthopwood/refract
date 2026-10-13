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
use std::sync::{Arc, Mutex as StdMutex};

use serde_json::Value;

use crate::events::EventSink;
use crate::session::agent::{SharedRegistry, SharedSettings};
use crate::session::SessionAgent;

/// Owns every live `SessionAgent` (one per Session opened this run) plus the shared registry/
/// settings stores every agent and every registry-only IPC handler already uses.
pub struct SessionManager {
    pub registry: SharedRegistry,
    pub settings: SharedSettings,
    events: EventSink,
    agents: StdMutex<HashMap<String, Arc<SessionAgent>>>,
    visible_ids: Arc<StdMutex<HashSet<String>>>,
}

impl SessionManager {
    pub fn new(registry: SharedRegistry, settings: SharedSettings, events: EventSink) -> Arc<Self> {
        Arc::new(Self { registry, settings, events, agents: StdMutex::new(HashMap::new()), visible_ids: Arc::new(StdMutex::new(HashSet::new())) })
    }

    pub fn get_agent(&self, session_id: &str) -> Option<Arc<SessionAgent>> {
        self.agents.lock().expect("agents mutex poisoned").get(session_id).cloned()
    }

    /// `SessionManager.ts`'s own `getOrCreateAgent`: a brand-new instance on first access,
    /// returning the existing one for every later call -- never starts it (callers start a
    /// `stopped` agent explicitly).
    pub fn get_or_create_agent(&self, session_id: &str) -> Arc<SessionAgent> {
        let mut agents = self.agents.lock().expect("agents mutex poisoned");
        if let Some(existing) = agents.get(session_id) {
            return existing.clone();
        }
        let agent = SessionAgent::new(session_id.to_string(), self.registry.clone(), self.settings.clone(), self.events.clone(), self.visible_ids.clone());
        agents.insert(session_id.to_string(), agent.clone());
        agent
    }

    pub fn notify_list_changed(&self) {
        self.events.emit_session_list_changed();
    }

    pub fn emit_settings_changed(&self, settings: &Value) {
        self.events.emit_settings_changed(settings);
    }

    /// `sessions.list()`'s live-runtime fields, merged over the registry-only `Session` row
    /// (data-model.md: "absent until the first `get_state`" for a Session with no agent this
    /// run, matching `SessionManager.summaries()`'s own no-runtime branch exactly). Does not
    /// port `detectUnexpectedTermination`'s own tail read (`terminatedUnexpectedly` is always
    /// absent, see `session::agent`'s own header).
    pub async fn summaries(&self) -> Vec<Value> {
        let sessions = self.registry.lock().await.snapshot().sessions;
        let launched_mode = serde_json::to_value(self.settings.lock().await.get().approval_mode).expect("ApprovalMode is always JSON-serialisable");

        let mut summaries = Vec::with_capacity(sessions.len());
        for session in &sessions {
            let mut summary = serde_json::to_value(session).expect("Session is always JSON-serialisable");
            let object = summary.as_object_mut().expect("Session serialises to a JSON object");
            match self.get_agent(&session.id) {
                Some(agent) => {
                    let live = agent.summary_fields().await;
                    for (key, value) in live.as_object().expect("summary_fields is always a JSON object") {
                        object.insert(key.clone(), value.clone());
                    }
                }
                None => {
                    let worktree_exists = tokio::fs::metadata(&session.worktree_path).await.is_ok();
                    let stop_reason = if worktree_exists { "not-started" } else { "worktree-missing" };
                    object.insert("status".to_string(), Value::String("stopped".to_string()));
                    object.insert("stopReason".to_string(), Value::String(stop_reason.to_string()));
                    object.insert("unread".to_string(), Value::Bool(false));
                    object.insert("launchedMode".to_string(), launched_mode.clone());
                    object.insert("pendingMode".to_string(), Value::Null);
                }
            }
            summaries.push(summary);
        }
        summaries
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
        let agents: Vec<Arc<SessionAgent>> = self.agents.lock().expect("agents mutex poisoned").values().cloned().collect();
        let mut handles = Vec::with_capacity(agents.len());
        for agent in agents {
            handles.push(tokio::spawn(async move { agent.shutdown().await }));
        }
        for handle in handles {
            let _ = handle.await;
        }
    }
}
