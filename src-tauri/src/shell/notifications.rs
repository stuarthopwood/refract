// OS notification on session status change, with click-to-focus (lane R10b, issue #793): port of
// `src/main/notifications.ts`'s own "a Notification only when no Refract window has OS focus and
// only when a Session becomes `needs-you`, or finishes (`working` -> `idle`). Clicking focuses
// the window and emits `ui:open-session`." Driven from `events::EventSink::emit_session_status`
// (the one place every status transition already flows through) rather than from
// `session::agent` directly: Rust has no single process-wide event bus to subscribe a second
// listener to the way Electron's `SessionManager.onEvent` gives `registerNotifications` for free
// (`events.rs`'s own doc comment), and `session/agent/*` is touched only through its named hooks
// (`on_frame`/`on_exit`/`on_start_progress`/per-lane `State`), none of which fire on a status
// change.
//
// Unlike Electron (one `Notification` instance per fire, with its own `.on('click', ...)` closure
// capturing that fire's `sessionId`), `tauri-plugin-notification`'s desktop implementation has
// ONE global `on_action` handler for the app's whole lifetime: the Session id instead round-trips
// through the notification's own `extra` payload (`NotificationBuilder::extra`), read back from
// `ActionPerformed::notification()::extra()` -- confirmed from the plugin's own source
// (`desktop.rs`'s `imp::wait`/`performed()`: the `data` handed to `show_tracked` IS the builder's
// own serialised `NotificationData`, `extra` included, on every desktop platform this build
// targets, not just mobile -- `ActiveNotification`'s rustdoc mentioning "mobile only" describes
// the unrelated `Notification::active()` listing accessor, not this click payload).
//
// No JS/webview capability needed (`capabilities/default.json`'s own doc comment: capabilities
// gate webview-to-plugin calls only): every call here is Rust-side (`app.notification()`), never
// invoked from the renderer.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex as StdMutex};

use serde_json::Value;
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;
use tokio::sync::Mutex as AsyncMutex;

use crate::events::UI_OPEN_SESSION;
use crate::store::registry::RegistryStore;

/// The previous `status` string seen for each session id, so a repeat `session:status` emit for
/// an unrelated field (e.g. `unread`) never re-fires a notification -- mirrors `notifications.ts`'s
/// own `lastStatus` `Map`, module-scoped there the same way (one process, one map, for the app's
/// whole lifetime).
static LAST_STATUS: LazyLock<StdMutex<HashMap<String, String>>> =
    LazyLock::new(|| StdMutex::new(HashMap::new()));

/// Registers the one global click handler (issue #793): focuses the window and emits
/// `ui:open-session` for the Session id carried in the clicked notification's own `extra`
/// payload. Call once, from `lib.rs`'s `setup` closure, before any notification is ever shown --
/// `tauri_plugin_notification`'s own `show()` only tracks a notification's action at all when a
/// handler/listener already exists at the moment it is shown.
pub fn init(app: &AppHandle) {
    let app_for_action = app.clone();
    let _ = app.notification().on_action(move |performed| {
        // "tap" is a click on the notification body itself; this build registers no action
        // buttons (no `action_type_id`), so nothing else is ever reported.
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
        // Matches `notifications.ts`'s own click handler exactly: restore if minimised, then
        // focus, then hand the renderer the Session id to open.
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

/// Whether `previous` -> `status` is a needs-you/finished transition worth a notification
/// (`notifications.ts`'s own rule: "only when a Session becomes `needs-you`, or finishes
/// (`working` -> `idle`)"). `Some(true)` for a needs-you transition, `Some(false)` for a
/// finished (working -> idle) one, `None` for every other change (a repeat `needs-you`, any
/// other idle transition, a stopped Session, ...). Pure and side-effect-free so it is
/// unit-testable with no app/registry/window at all.
fn notification_worthy_transition(previous: Option<&str>, status: &str) -> Option<bool> {
    if status == "needs-you" && previous != Some("needs-you") {
        Some(true)
    } else if previous == Some("working") && status == "idle" {
        Some(false)
    } else {
        None
    }
}

/// `events::EventSink::emit_session_status`'s own one-line hook: decides whether this status
/// change is a needs-you/finished transition worth a notification, skips it when the window
/// already has OS focus (`notifications.ts`'s own `window.isFocused()` check), then looks up the
/// Session's live display name and shows it. The registry lock is async (`tokio::sync::Mutex`),
/// so the lookup and the `show()` call both run on a spawned task -- `emit_session_status` itself
/// stays a plain, non-blocking `fn` like every other `EventSink` method.
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
        if let Err(err) = app
            .notification()
            .builder()
            .title("Refract")
            .body(body)
            .extra("sessionId", session_id.clone())
            .show()
        {
            log::warn!("refract-tauri: failed to show notification for {session_id}: {err}");
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
        // Only a `working` -> `idle` transition is "finished"; any other predecessor (stopped,
        // needs-you, none at all) reaching `idle` is not.
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
