// OS notification on Session status change, with click-to-focus. Shown from `events::EventSink::emit_session_status`.
// The Session id rides in the notification `extra` payload, since the plugin has one global action handler.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex as StdMutex};

use serde_json::Value;
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;
use tokio::sync::Mutex as AsyncMutex;

use crate::events::UI_OPEN_SESSION;
use crate::store::registry::RegistryStore;
use crate::store::settings::SettingsStore;

/// Previous `status` per Session id, so a repeat emit for an unrelated field never re-notifies.
static LAST_STATUS: LazyLock<StdMutex<HashMap<String, String>>> =
    LazyLock::new(|| StdMutex::new(HashMap::new()));

/// Drops entries for Sessions no longer in the registry, so the map cannot grow forever.
fn retain_only(
    last_status: &mut HashMap<String, String>,
    valid_ids: &std::collections::HashSet<String>,
) {
    last_status.retain(|id, _| valid_ids.contains(id));
}

/// Prunes `LAST_STATUS` to the registry's current Sessions whenever the list changes.
/// The registry lock is async, so this runs on a spawned task.
pub fn prune_deleted_sessions(registry: Arc<AsyncMutex<RegistryStore>>) {
    tauri::async_runtime::spawn(async move {
        let valid_ids: std::collections::HashSet<String> = registry
            .lock()
            .await
            .snapshot()
            .sessions
            .into_iter()
            .map(|s| s.id)
            .collect();
        retain_only(
            &mut LAST_STATUS.lock().expect("LAST_STATUS mutex poisoned"),
            &valid_ids,
        );
    });
}

/// Registers the one global click handler. Call once, before any notification is shown.
/// The plugin only tracks a shown notification's action when a handler already exists.
pub fn init(app: &AppHandle) {
    let app_for_action = app.clone();
    let _ = app.notification().on_action(move |performed| {
        // "tap" is the notification body click; no action buttons are registered.
        if performed.action_id() != "tap" {
            return;
        }
        let Some(session_id) = performed
            .notification()
            .and_then(|n| n.extra().get("sessionId"))
            .and_then(|v| v.as_str())
            .map(str::to_owned)
        else {
            return;
        };
        let Some(window) = app_for_action.get_webview_window("main") else {
            return;
        };
        // Restore if minimised, then focus, then open the Session.
        if window.is_minimized().unwrap_or(false) {
            let _ = window.unminimize();
        }
        let _ = window.show();
        let _ = window.set_focus();
        crate::events::emit(
            &app_for_action,
            UI_OPEN_SESSION,
            serde_json::json!({ "sessionId": session_id }),
        );
    });
}

/// Whether `previous` -> `status` is a needs-you or finished transition worth a notification.
/// `Some(true)` is needs-you, `Some(false)` is finished, `None` is anything else.
fn notification_worthy_transition(previous: Option<&str>, status: &str) -> Option<bool> {
    if status == "needs-you" && previous != Some("needs-you") {
        Some(true)
    } else if previous == Some("working") && status == "idle" {
        Some(false)
    } else {
        None
    }
}

/// Shows a notification for a needs-you or finished transition, unless the window has focus.
/// The registry lock is async, so the lookup and `show()` run on a spawned task.
pub fn on_session_status(
    app_handle: Arc<StdMutex<Option<AppHandle>>>,
    registry: Arc<AsyncMutex<RegistryStore>>,
    payload: Value,
) {
    let Some(session_id) = payload.get("sessionId").and_then(Value::as_str) else {
        return;
    };
    let Some(status) = payload.get("status").and_then(Value::as_str) else {
        return;
    };
    let previous = {
        let mut last = LAST_STATUS.lock().expect("LAST_STATUS mutex poisoned");
        let previous = last.get(session_id).cloned();
        last.insert(session_id.to_string(), status.to_string());
        previous
    };
    let Some(became_needs_you) = notification_worthy_transition(previous.as_deref(), status) else {
        return;
    };
    let Some(app) = app_handle
        .lock()
        .expect("app_handle mutex poisoned")
        .clone()
    else {
        return;
    };
    if let Some(window) = app.get_webview_window("main") {
        if window.is_focused().unwrap_or(false) {
            return;
        }
    }
    let session_id = session_id.to_string();
    tauri::async_runtime::spawn(async move {
        let name = registry
            .lock()
            .await
            .get_session(&session_id)
            .map(|s| s.name.clone())
            .unwrap_or_else(|| "A Session".to_string());
        let body = if became_needs_you {
            format!("{name} needs your input.")
        } else {
            format!("{name} finished.")
        };
        // Managed in `lib.rs` setup; absent only before setup, when no Session can have notified.
        let sounds = match app.try_state::<Arc<AsyncMutex<SettingsStore>>>() {
            Some(settings) => settings.lock().await.session_notification_sounds(),
            None => true,
        };
        let mut notification = app
            .notification()
            .builder()
            .title("Refract")
            .body(body)
            .extra("sessionId", session_id.clone());
        if sounds {
            // Windows toast sound names: "Reminder" for a prompt, "Default" for a plain finish.
            notification = notification.sound(if became_needs_you {
                "Reminder"
            } else {
                "Default"
            });
        }
        if let Err(err) = notification.show() {
            log::warn!("refract-tauri: failed to show notification: {err}");
        }
    });
}

#[cfg(test)]
mod notification_worthy_transition_tests {
    use super::notification_worthy_transition;

    #[test]
    fn idle_to_needs_you_notifies() {
        assert_eq!(
            notification_worthy_transition(Some("idle"), "needs-you"),
            Some(true)
        );
    }

    #[test]
    fn working_to_needs_you_notifies() {
        assert_eq!(
            notification_worthy_transition(Some("working"), "needs-you"),
            Some(true)
        );
    }

    #[test]
    fn first_ever_status_needs_you_notifies() {
        assert_eq!(
            notification_worthy_transition(None, "needs-you"),
            Some(true)
        );
    }

    #[test]
    fn repeat_needs_you_does_not_renotify() {
        assert_eq!(
            notification_worthy_transition(Some("needs-you"), "needs-you"),
            None
        );
    }

    #[test]
    fn working_to_idle_notifies_as_finished() {
        assert_eq!(
            notification_worthy_transition(Some("working"), "idle"),
            Some(false)
        );
    }

    #[test]
    fn idle_to_idle_does_not_notify() {
        assert_eq!(notification_worthy_transition(Some("idle"), "idle"), None);
    }

    #[test]
    fn stopped_to_idle_does_not_notify() {
        // Only working -> idle counts as finished.
        assert_eq!(
            notification_worthy_transition(Some("stopped"), "idle"),
            None
        );
    }

    #[test]
    fn needs_you_to_idle_does_not_notify() {
        assert_eq!(
            notification_worthy_transition(Some("needs-you"), "idle"),
            None
        );
    }

    #[test]
    fn first_ever_status_idle_does_not_notify() {
        assert_eq!(notification_worthy_transition(None, "idle"), None);
    }

    #[test]
    fn working_to_working_does_not_notify() {
        assert_eq!(
            notification_worthy_transition(Some("working"), "working"),
            None
        );
    }
}

#[cfg(test)]
mod retain_only_tests {
    use std::collections::{HashMap, HashSet};

    use super::retain_only;

    #[test]
    fn drops_entries_not_in_the_valid_set() {
        let mut last_status = HashMap::from([
            ("kept".to_string(), "idle".to_string()),
            ("deleted".to_string(), "needs-you".to_string()),
        ]);
        let valid_ids = HashSet::from(["kept".to_string()]);
        retain_only(&mut last_status, &valid_ids);
        assert_eq!(last_status.len(), 1);
        assert!(last_status.contains_key("kept"));
    }

    #[test]
    fn keeps_every_entry_still_valid() {
        let mut last_status = HashMap::from([
            ("a".to_string(), "idle".to_string()),
            ("b".to_string(), "working".to_string()),
        ]);
        let valid_ids = HashSet::from(["a".to_string(), "b".to_string()]);
        retain_only(&mut last_status, &valid_ids);
        assert_eq!(last_status.len(), 2);
    }

    #[test]
    fn empty_valid_set_drops_everything() {
        let mut last_status = HashMap::from([("a".to_string(), "idle".to_string())]);
        retain_only(&mut last_status, &HashSet::new());
        assert!(last_status.is_empty());
    }
}
