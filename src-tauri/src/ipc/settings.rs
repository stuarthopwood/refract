// IPC handlers for `settings.*` (contracts/ipc.md "Settings", tasks.md T015/T028). Milestone 1
// only wires `settings.get` and `settings.setApprovalMode` (`parity.md`); every other
// `settings.*` channel is `later` and stays unregistered. `settings.setApprovalMode` persists the
// mode and broadcasts `settings:changed` (T028, port of `ipc/broadcast.ts`'s own
// `broadcastSettingsChanged`) so every window stays in sync even for a caller that reaches this
// channel directly instead of through the renderer store's own self-updating action. Not ported
// (`session::agent`'s own header): fanning `pendingMode` out to every LIVE Session and restarting
// each at its own next settle (`SessionManager.applyPendingModeChange`/`SessionAgent.restart`,
// T031/T032) -- this build has no `restart()`, so an already-running Session keeps its OLD mode
// until the next time it is stopped and reopened; only a Session started (or restarted by this
// channel in the Electron build) AFTER this call picks up the new mode.

use serde_json::Value;

use crate::store::settings::ApprovalMode;

use super::{invalid_argument, AppState, Dispatcher, HandlerFuture};

pub fn register(d: &mut Dispatcher) {
    d.register("settings.get", settings_get);
    d.register("settings.setApprovalMode", settings_set_approval_mode);
}

pub fn settings_get(state: AppState, _args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let settings = state.settings.lock().await.get();
        Ok(serde_json::to_value(settings).expect("Settings is always JSON-serialisable"))
    })
}

pub fn settings_set_approval_mode(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let mode = match args
            .first()
            .and_then(|v| v.as_str())
            .and_then(parse_approval_mode)
        {
            Some(mode) => mode,
            None => {
                return Err(invalid_argument(
                    "settings.setApprovalMode expects one of 'ask' | 'edit-freely' | 'auto'",
                ))
            }
        };
        let value = state
            .settings
            .lock()
            .await
            .set_approval_mode(mode)
            .await
            .map_err(|err| super::IpcError::new("git-failed", err.to_string()))?;
        let value_json = serde_json::to_value(value).expect("Settings is always JSON-serialisable");
        state.session_manager.emit_settings_changed(&value_json);
        Ok(value_json)
    })
}

fn parse_approval_mode(value: &str) -> Option<ApprovalMode> {
    serde_json::from_value(Value::String(value.to_string())).ok()
}
