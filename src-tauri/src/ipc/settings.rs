// IPC handlers for `settings.*` (contracts/ipc.md "Settings", tasks.md T015). Milestone 1 only
// wires `settings.get` and `settings.setApprovalMode` (`parity.md`); every other `settings.*`
// channel is `later` and stays unregistered. `settings.setApprovalMode` persists the mode only --
// fanning `pendingMode` out to every live Session (`SessionManager.applyPendingModeChange`) and
// broadcasting `settings:changed` both need the live `session::manager`/`events` Phase 3 provides,
// so neither happens here yet (this slice's own assignment explicitly defers both).

use serde_json::Value;

use crate::store::settings::ApprovalMode;

use super::{invalid_argument, AppState, HandlerFuture};

pub fn settings_get(state: AppState, _args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let settings = state.settings.lock().await.get();
        Ok(serde_json::to_value(settings).expect("Settings is always JSON-serialisable"))
    })
}

pub fn settings_set_approval_mode(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let mode = match args.first().and_then(|v| v.as_str()).and_then(parse_approval_mode) {
            Some(mode) => mode,
            None => return Err(invalid_argument("settings.setApprovalMode expects one of 'ask' | 'edit-freely' | 'auto'")),
        };
        let value = state
            .settings
            .lock()
            .await
            .set_approval_mode(mode)
            .await
            .map_err(|err| super::IpcError::new("git-failed", err.to_string()))?;
        Ok(serde_json::to_value(value).expect("Settings is always JSON-serialisable"))
    })
}

fn parse_approval_mode(value: &str) -> Option<ApprovalMode> {
    serde_json::from_value(Value::String(value.to_string())).ok()
}
