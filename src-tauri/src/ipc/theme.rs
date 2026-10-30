// Theme IPC channels `theme.preview`/`theme.set` (#791). `theme.preview` only validates: the
// window uses native decorations, so there is no title-bar overlay to update.
// A bad id is `invalid-theme`, not `invalid-argument`, so the renderer can tell them apart.

use serde_json::Value;

use crate::store::settings::ThemeId;

use super::{arg_str, AppState, Dispatcher, HandlerFuture, IpcError};

pub fn register(d: &mut Dispatcher) {
    d.register("theme.preview", theme_preview);
    d.register("theme.set", theme_set);
}

fn parse_theme_id(value: &str) -> Option<ThemeId> {
    serde_json::from_value(Value::String(value.to_string())).ok()
}

/// Caps an echoed caller value to a bounded length before it reaches an error message.
fn describe_value(value: &Value) -> String {
    let text = value.to_string();
    if text.chars().count() > 200 {
        format!("{}…", text.chars().take(200).collect::<String>())
    } else {
        text
    }
}

/// Validates `theme.preview`'s argument. A missing argument is rejected too (Electron parity);
/// only an explicit `null` means "revert".
fn validate_preview_arg(arg: Option<&Value>) -> Result<(), IpcError> {
    match arg {
        Some(Value::Null) => Ok(()),
        Some(Value::String(id)) if parse_theme_id(id).is_some() => Ok(()),
        Some(other) => Err(IpcError::new(
            "invalid-theme",
            format!(
                "theme.preview expects a known theme id or null, got {}",
                describe_value(other)
            ),
        )),
        None => Err(IpcError::new(
            "invalid-theme",
            "theme.preview expects a known theme id or null, got no argument",
        )),
    }
}

/// `theme.preview(themeId | null)`: validates the id (or `null` to revert); never persisted.
pub fn theme_preview(_state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        validate_preview_arg(args.first())?;
        Ok(Value::Null)
    })
}

/// `theme.set(themeId)`: persists the choice and broadcasts `settings:changed` to every window.
pub fn theme_set(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let theme = match arg_str(&args, 0).and_then(parse_theme_id) {
            Some(theme) => theme,
            None => {
                return Err(IpcError::new(
                    "invalid-theme",
                    format!(
                        "theme.set expects a known theme id, got {}",
                        describe_value(args.first().unwrap_or(&Value::Null))
                    ),
                ))
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::settings::SettingsStore;

    async fn open_scratch_store() -> SettingsStore {
        let dir = std::env::temp_dir().join(format!("refract-theme-test-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        SettingsStore::open(&dir).await.unwrap()
    }

    #[test]
    fn parse_theme_id_accepts_known_ids_and_rejects_unknown() {
        assert!(parse_theme_id("dark").is_some());
        assert!(parse_theme_id("dark-high-contrast").is_some());
        assert!(parse_theme_id("obsidian").is_some());
        assert!(parse_theme_id("not-a-theme").is_none());
    }

    #[tokio::test]
    async fn theme_set_persists_and_the_next_bootstrap_read_sees_it() {
        let mut store = open_scratch_store().await;
        let next = store.set_theme(ThemeId::Obsidian).await.unwrap();
        assert!(matches!(next.theme, ThemeId::Obsidian));
        // The synchronous bootstrap reads `settings.get().theme` off a freshly-opened store.
        assert!(matches!(store.get().theme, ThemeId::Obsidian));
    }

    #[test]
    fn describe_value_truncates_a_long_echoed_argument() {
        let huge = Value::String("x".repeat(500));
        let described = describe_value(&huge);
        assert!(described.chars().count() <= 203);
        assert!(described.ends_with('…'));
    }

    #[test]
    fn validate_preview_arg_accepts_a_known_id_or_explicit_null_rejects_everything_else() {
        assert!(validate_preview_arg(Some(&Value::String("dark".to_string()))).is_ok());
        assert!(validate_preview_arg(Some(&Value::Null)).is_ok());
        assert_eq!(
            validate_preview_arg(Some(&Value::String("not-a-theme".to_string())))
                .unwrap_err()
                .code,
            "invalid-theme"
        );
        // A missing argument is rejected, unlike an explicit `null`.
        assert_eq!(
            validate_preview_arg(None).unwrap_err().code,
            "invalid-theme"
        );
    }
}
