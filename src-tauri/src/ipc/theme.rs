// Theme IPC channels (lane R8, issue #791): `theme.preview`/`theme.set`, port of
// `src/main/ipc/theme.ts` (the synchronous `theme:bootstrap` channel is already done, wired
// directly in `lib.rs`'s own `setup` closure via an initialization script -- see that file's own
// FR-010/FR-011 comment; nothing here duplicates it).
//
// Not ported: Electron's `applyTitleBarOverlay` (`src/main/titleBarOverlay.ts`,
// `BrowserWindow.setTitleBarOverlay`). This build's one window uses plain native OS decorations
// (`lib.rs`: "no custom caption parity in milestone 1") rather than Electron's merged/hidden
// title bar, so there is no title-bar-overlay colour subsystem to update here at all -- every
// other surface already repaints from the renderer's own CSS theme class with no IPC round trip
// (`theme.ts`'s own comment), which is why `theme.preview` below is otherwise a pure validate-
// and-succeed no-op: there is nothing left for it to apply once the overlay call is gone.

use serde_json::Value;

use crate::store::settings::ThemeId;

use super::{arg_str, invalid_argument, AppState, Dispatcher, HandlerFuture};

pub fn register(d: &mut Dispatcher) {
    d.register("theme.preview", theme_preview);
    d.register("theme.set", theme_set);
}

fn parse_theme_id(value: &str) -> Option<ThemeId> {
    serde_json::from_value(Value::String(value.to_string())).ok()
}

/// `theme.preview(themeId | null)` (FR-003 to FR-005, FR-017): validates the id (or `null`, which
/// reverts a preview) and succeeds -- see the module header for why there is no live window
/// effect to apply in this build. Never persisted.
pub fn theme_preview(_state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        match args.first() {
            None | Some(Value::Null) => {}
            Some(Value::String(id)) if parse_theme_id(id).is_some() => {}
            Some(other) => {
                return Err(invalid_argument(format!(
                    "theme.preview expects a known theme id or null, got {other}"
                )))
            }
        }
        Ok(Value::Null)
    })
}

/// `theme.set(themeId)` (FR-004): persists the choice (the one and only place allowed to turn
/// `SettingsStore`'s own `raw_theme` into a real, developer-saved value) and broadcasts
/// `settings:changed` so every open window/pane picks it up immediately -- matches
/// `settings.setApprovalMode`'s own persist-then-broadcast pattern.
pub fn theme_set(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let theme = match arg_str(&args, 0).and_then(parse_theme_id) {
            Some(theme) => theme,
            None => {
                return Err(invalid_argument(format!(
                    "theme.set expects a known theme id, got {}",
                    args.first().cloned().unwrap_or(Value::Null)
                )))
            }
        };
        let value = state
            .settings
            .lock()
            .await
            .set_theme(theme)
            .await
            .map_err(|err| super::IpcError::new("git-failed", err.to_string()))?;
        let value_json = serde_json::to_value(value).expect("Settings is always JSON-serialisable");
        state.session_manager.emit_settings_changed(&value_json);
        Ok(value_json)
    })
}
