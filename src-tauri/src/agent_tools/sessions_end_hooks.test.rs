// What the fake host does while a cascade shuts agents down: a rendezvous only concurrent
// shutdowns pass, an ordered event log, and a tree change made mid-shutdown.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::Barrier;

use super::tests::FakeHost;
use crate::agent_tools::tree_gate;
use crate::store::registry::Session;

/// A change made to the registry while the cascade's agents are stopping.
pub(in crate::agent_tools) enum WhileShuttingDown {
    Add(Box<Session>),
}

#[derive(Default)]
pub(in crate::agent_tools) struct Probe {
    /// Every shutdown waits here, so a sequential loop never gets past the first one.
    pub barrier: Mutex<Option<Arc<Barrier>>>,
    pub change: Mutex<Option<WhileShuttingDown>>,
    /// `shutdown:<id>` and `archive:<id>` in the order they happened.
    pub events: Mutex<Vec<String>>,
    /// Whether the Project's tree gate could be taken during a shutdown; `None` until one ran.
    pub gate_was_free: Mutex<Option<bool>>,
    /// The Project whose tree gate the cascade takes, so the probe checks the right one.
    pub repo: String,
}

pub(in crate::agent_tools) async fn shut_down(host: &FakeHost, id: &str) {
    host.shutdowns.lock().unwrap().push(id.to_string());
    host.probe
        .events
        .lock()
        .unwrap()
        .push(format!("shutdown:{id}"));
    let barrier = host.probe.barrier.lock().unwrap().clone();
    if let Some(barrier) = barrier {
        barrier.wait().await;
    }
    let change = host.probe.change.lock().unwrap().take();
    if let Some(WhileShuttingDown::Add(session)) = change {
        let free = tokio::time::timeout(Duration::from_secs(5), tree_gate::lock(&host.probe.repo))
            .await
            .is_ok();
        *host.probe.gate_was_free.lock().unwrap() = Some(free);
        host.registry
            .lock()
            .await
            .add_session(*session)
            .await
            .unwrap();
    }
}

/// Moves `id` to the top of the Project, out of whatever tree it sat in.
pub(in crate::agent_tools) async fn unparent(host: &FakeHost, id: &str) {
    let patch = crate::store::registry::SessionPatch {
        parent_session_id: Some(None),
        ..Default::default()
    };
    host.registry
        .lock()
        .await
        .update_session(id, patch)
        .await
        .unwrap();
}
