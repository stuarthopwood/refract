// The stop action behind `sessions.stopAgent`, callable without IPC arguments so the agent
// tools share it.

use crate::ipc::{not_found, AppState, IpcError};

/// Closes stdin, waits briefly, then force-kills the process tree.
pub(crate) async fn stop_core(state: &AppState, id: &str) -> Result<(), IpcError> {
    if state.registry.lock().await.get_session(id).is_none() {
        return Err(not_found(format!("Session not found: {id}")));
    }
    state
        .session_manager
        .get_or_create_agent(id)
        .shutdown()
        .await;
    Ok(())
}
