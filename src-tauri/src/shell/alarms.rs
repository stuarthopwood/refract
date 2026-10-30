// Alarm scheduler (#1426): one task, one timer for the soonest active alarm, no timer per alarm.
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;
use tokio::sync::{Mutex as AsyncMutex, Notify};

use crate::events::{emit, ALARM_FIRED, SETTINGS_CHANGED};
use crate::store::settings::{Alarm, SettingsStore};

static WAKE: LazyLock<Notify> = LazyLock::new(Notify::new);

/// Caps each sleep so a system sleep or clock change delays an alarm by at most this long.
const MAX_SLEEP: Duration = Duration::from_secs(60);

/// Re-reads the alarm list now; call after any alarm write.
pub fn wake_scheduler() {
    WAKE.notify_one();
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn show_notification(app: &AppHandle, alarm: &Alarm) {
    let body = if alarm.label.is_empty() {
        "Alarm".to_string()
    } else {
        alarm.label.clone()
    };
    if let Err(err) = app
        .notification()
        .builder()
        .title("Refract alarm")
        .body(body)
        .show()
    {
        log::warn!("refract-tauri: failed to show alarm notification: {err}");
    }
}

/// Spawns the scheduler for the app's lifetime.
pub fn spawn(app: AppHandle, settings: Arc<AsyncMutex<SettingsStore>>) {
    tauri::async_runtime::spawn(async move {
        loop {
            let now = now_ms();
            let (fired, snapshot, next) = {
                let mut store = settings.lock().await;
                let fired = store.take_due_alarms(now).await.unwrap_or_else(|err| {
                    log::warn!("refract-tauri: failed to save fired alarms: {err}");
                    Vec::new()
                });
                (fired, store.get(), store.next_alarm_ms())
            };
            if !fired.is_empty() {
                for alarm in &fired {
                    show_notification(&app, alarm);
                    emit(&app, ALARM_FIRED, alarm);
                }
                emit(&app, SETTINGS_CHANGED, &snapshot);
            }
            match next {
                None => WAKE.notified().await,
                Some(at) => {
                    let wait = Duration::from_millis((at - now).max(0) as u64).min(MAX_SLEEP);
                    tokio::select! {
                        _ = tokio::time::sleep(wait) => {}
                        _ = WAKE.notified() => {}
                    }
                }
            }
        }
    });
}
