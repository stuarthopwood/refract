// IPC handler for `settings.setReduceMotion`. Own file to respect the 600-line cap (#806).
use serde_json::Value;

use super::settings::require_bool;
use super::{AppState, Dispatcher, HandlerFuture};

pub fn register(d: &mut Dispatcher) {
    d.register("settings.setReduceMotion", settings_set_reduce_motion);
}

pub fn settings_set_reduce_motion(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let enabled = require_bool(&args, 0, "settings.setReduceMotion", "enabled")?;
        let value = state
            .settings
            .lock()
            .await
            .set_reduce_motion(enabled)
            .await
            .map_err(|err| super::IpcError::new("git-failed", err.to_string()))?;
        let value_json = serde_json::to_value(value).expect("Settings is always JSON-serialisable");
        state.session_manager.emit_settings_changed(&value_json);
        Ok(value_json)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::EventSink;
    use crate::session::SessionManager;
    use crate::store::registry::RegistryStore;
    use crate::store::settings::SettingsStore;
    use serde_json::json;
    use std::sync::{Arc, Mutex as StdMutex};
    use tokio::sync::Mutex as AsyncMutex;

    async fn make_state() -> AppState {
        let dir = crate::test_scratch::path(format!(
            "refract-reduce-motion-ipc-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let registry = RegistryStore::open(&dir).await.expect("open registry");
        let settings = SettingsStore::open(&dir).await.expect("open settings");
        let registry = Arc::new(AsyncMutex::new(registry));
        let settings = Arc::new(AsyncMutex::new(settings));
        let app_handle_slot: Arc<StdMutex<Option<tauri::AppHandle>>> =
            Arc::new(StdMutex::new(None));
        let events = EventSink::new(app_handle_slot.clone(), registry.clone());
        let session_manager = SessionManager::new(registry.clone(), settings.clone(), events);
        AppState {
            data_dir: dir,
            registry,
            settings,
            app_handle: app_handle_slot,
            session_manager,
        }
    }

    #[tokio::test]
    async fn a_non_boolean_argument_is_rejected_and_leaves_settings_unchanged() {
        for bad in [json!("yes"), json!(1), json!(null)] {
            let state = make_state().await;
            let err = settings_set_reduce_motion(state.clone(), vec![bad.clone()])
                .await
                .expect_err("a non-boolean must be rejected");
            assert_eq!(err.code, "invalid-argument", "{bad}");
            assert!(!state.settings.lock().await.get().reduce_motion, "{bad}");
        }
    }

    #[tokio::test]
    async fn a_missing_argument_is_rejected() {
        let state = make_state().await;
        let err = settings_set_reduce_motion(state, vec![])
            .await
            .expect_err("a missing argument must be rejected");
        assert_eq!(err.code, "invalid-argument");
    }

    #[tokio::test]
    async fn a_boolean_is_stored_and_returned_under_reduce_motion() {
        let state = make_state().await;
        let result = settings_set_reduce_motion(state.clone(), vec![json!(true)])
            .await
            .expect("a boolean must be accepted");
        assert_eq!(result["reduceMotion"], json!(true));
        assert!(state.settings.lock().await.get().reduce_motion);
    }
}
