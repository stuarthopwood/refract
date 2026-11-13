// Narrow access for `crate::agent_tools` into one Session (spec 124). Kept apart so the host tool
// channel needs no other `session::agent` internals.

use std::sync::{Arc, Weak};

use super::{PendingRequest, SessionAgent, SessionStatus};
use crate::agent_tools::router::ToolRouter;
use crate::events::EventSink;
use crate::omp::process::OmpProcess;
use crate::omp::transcript::RequestResolution;
use crate::session::SessionManager;
use crate::store::settings::ApprovalMode;

impl SessionAgent {
    pub fn attach_manager(&self, manager: Weak<SessionManager>) {
        let _ = self.manager.set(manager);
    }

    /// The owning manager, for the Session tools. `None` once the app is shutting down.
    pub fn tool_manager(&self) -> Option<Arc<SessionManager>> {
        self.manager.get().and_then(Weak::upgrade)
    }

    pub fn tool_router(&self) -> &ToolRouter {
        &self.agent_tools
    }

    pub fn tool_session_id(&self) -> &str {
        &self.session_id
    }

    /// The shared registry, for tools that create or change Session rows.
    pub fn tool_registry(&self) -> &super::SharedRegistry {
        self.registry()
    }

    pub fn tool_events(&self) -> &EventSink {
        &self.events
    }

    pub async fn tool_process(&self) -> Option<Arc<OmpProcess>> {
        self.state.lock().await.process.clone()
    }

    /// Yolo skips Refract's own approval card, as it skips OMP's.
    pub async fn tool_is_yolo(&self) -> bool {
        self.state.lock().await.launched_mode == ApprovalMode::Auto
    }

    pub async fn tool_raise_approval(&self, request: PendingRequest) {
        self.push_pending_request(request).await;
    }

    /// Closes a Refract-owned card whose call ended before the developer answered. A no-op when
    /// the card is already gone.
    pub async fn tool_resolve_approval(&self, request_id: &str, resolution: RequestResolution) {
        let became_working = {
            let mut state = self.state.lock().await;
            let before = state.pending.len();
            state.pending.retain(|r| r.request_id() != request_id);
            if state.pending.len() == before {
                return;
            }
            state.pending.is_empty() && state.status == SessionStatus::NeedsYou
        };
        self.upsert_request_row(request_id, Some(resolution)).await;
        self.events
            .emit_request_resolved(&self.session_id, request_id);
        if became_working {
            self.set_status(SessionStatus::Working, None, None).await;
        }
    }
}
