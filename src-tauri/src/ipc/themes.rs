// Custom theme channels (#458): list, import, export, remove, reveal, and select. File contents are validated in Rust before they reach the renderer.

use serde_json::{json, Value};
use tauri_plugin_dialog::DialogExt;

use crate::store::theme_files;

use super::{arg_str, AppState, Dispatcher, HandlerFuture, IpcError};

pub fn register(d: &mut Dispatcher) {
    d.register("themes.list", themes_list);
    d.register("themes.import", themes_import);
    d.register("themes.export", themes_export);
    d.register("themes.remove", themes_remove);
    d.register("themes.openFolder", themes_open_folder);
    d.register("theme.setCustom", theme_set_custom);
}

fn bad_theme(message: impl Into<String>) -> IpcError {
    IpcError::new("invalid-theme", message)
}

fn app_handle(state: &AppState) -> Result<tauri::AppHandle, IpcError> {
    state
        .app_handle
        .lock()
        .expect("app_handle mutex poisoned")
        .clone()
        .ok_or_else(|| IpcError::new("unsupported", "No window yet"))
}

/// The active custom theme for the synchronous bootstrap, plus a notice when it had to be dropped. `--reset-theme` clears it first (#458).
pub async fn bootstrap(state: &AppState) -> (Value, Option<&'static str>) {
    let mut notice = None;
    let mut active = state.settings.lock().await.get().custom_theme;
    if active.is_some() && std::env::args().any(|arg| arg == "--reset-theme") {
        active = None;
        notice = Some("reset");
    }
    let loaded = match &active {
        Some(id) => theme_files::load(&theme_files::themes_dir(&state.data_dir), id).await,
        None => None,
    };
    if active.is_some() && loaded.is_none() {
        notice = Some("missing");
    }
    if notice.is_some() {
        let _ = state.settings.lock().await.set_custom_theme(None).await;
    }
    (
        loaded.map_or(Value::Null, |t| {
            serde_json::to_value(t).expect("ThemeFile is JSON")
        }),
        notice,
    )
}

pub fn themes_list(state: AppState, _args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let list = theme_files::list(&theme_files::themes_dir(&state.data_dir)).await;
        Ok(serde_json::to_value(list).expect("ThemeList is JSON-serialisable"))
    })
}

pub fn themes_import(state: AppState, _args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let handle = app_handle(&state)?;
        let picked = tokio::task::spawn_blocking(move || {
            handle
                .dialog()
                .file()
                .add_filter("Refract theme", &["json"])
                .blocking_pick_file()
        })
        .await
        .map_err(|err| IpcError::new("unsupported", err.to_string()))?;
        let Some(picked) = picked else {
            return Ok(Value::Null);
        };
        let path = picked
            .into_path()
            .map_err(|_| bad_theme("The chosen location is not a file path"))?;
        let file_name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let meta = tokio::fs::metadata(&path)
            .await
            .map_err(|_| bad_theme(format!("Couldn't read {file_name}")))?;
        if !meta.is_file() || meta.len() > theme_files::MAX_FILE_BYTES {
            return Err(bad_theme(format!(
                "Couldn't load {file_name}: not a theme file under 64 KiB"
            )));
        }
        let text = tokio::fs::read_to_string(&path)
            .await
            .map_err(|_| bad_theme(format!("Couldn't load {file_name}: not readable text")))?;
        let theme = theme_files::save_validated(&theme_files::themes_dir(&state.data_dir), &text)
            .await
            .map_err(|reason| bad_theme(format!("Couldn't load {file_name}: {reason}")))?;
        Ok(serde_json::to_value(theme).expect("ThemeFile is JSON-serialisable"))
    })
}

/// `themes.export(suggestedName, jsonText)`: re-validates the text, then writes where the user picks.
pub fn themes_export(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let name = arg_str(&args, 0)
            .filter(|n| !n.is_empty() && n.len() <= 64 && !n.contains(['/', '\\', ':']))
            .unwrap_or("theme.json")
            .to_string();
        let text = arg_str(&args, 1)
            .ok_or_else(|| bad_theme("themes.export expects the theme JSON text"))?
            .to_string();
        theme_files::parse_theme("export", &text).map_err(bad_theme)?;
        let handle = app_handle(&state)?;
        let picked = tokio::task::spawn_blocking(move || {
            handle
                .dialog()
                .file()
                .set_file_name(name)
                .add_filter("Refract theme", &["json"])
                .blocking_save_file()
        })
        .await
        .map_err(|err| IpcError::new("unsupported", err.to_string()))?;
        let Some(picked) = picked else {
            return Ok(Value::Null);
        };
        let path = picked
            .into_path()
            .map_err(|_| bad_theme("The chosen location is not a file path"))?;
        tokio::fs::write(&path, text)
            .await
            .map_err(|err| bad_theme(format!("The theme could not be saved: {err}")))?;
        Ok(Value::String(path.to_string_lossy().into_owned()))
    })
}

async fn clear_if_active(state: &AppState, id: &str) -> Result<(), IpcError> {
    let mut settings = state.settings.lock().await;
    if settings.get().custom_theme.as_deref() == Some(id) {
        let next = settings
            .set_custom_theme(None)
            .await
            .map_err(|err| IpcError::new("settings-write-failed", err.to_string()))?;
        state
            .session_manager
            .emit_settings_changed(&serde_json::to_value(next).expect("Settings is JSON"));
    }
    Ok(())
}

pub fn themes_remove(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let id = arg_str(&args, 0)
            .ok_or_else(|| bad_theme("themes.remove expects a theme id"))?
            .to_string();
        theme_files::remove(&theme_files::themes_dir(&state.data_dir), &id)
            .await
            .map_err(bad_theme)?;
        clear_if_active(&state, &id).await?;
        Ok(Value::Null)
    })
}

/// `themes.openFolder(id?)`: with an id, selects that file in Explorer; without, opens the folder.
pub fn themes_open_folder(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let dir = theme_files::themes_dir(&state.data_dir);
        tokio::fs::create_dir_all(&dir)
            .await
            .map_err(|err| IpcError::new("unsupported", err.to_string()))?;
        let result = match arg_str(&args, 0) {
            Some(id) => {
                let loaded = theme_files::load(&dir, id)
                    .await
                    .ok_or_else(|| bad_theme("That theme file is no longer valid"))?;
                tauri_plugin_opener::reveal_item_in_dir(dir.join(format!("{}.json", loaded.id)))
            }
            None => tauri_plugin_opener::open_path(dir, None::<&str>),
        };
        result.map_err(|err| IpcError::new("unsupported", err.to_string()))?;
        Ok(Value::Null)
    })
}

/// `theme.setCustom(id | null)`: persists the active custom theme after re-validating its file.
pub fn theme_set_custom(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let id = match args.first() {
            Some(Value::Null) => None,
            Some(Value::String(id)) => {
                let dir = theme_files::themes_dir(&state.data_dir);
                if theme_files::load(&dir, id).await.is_none() {
                    return Err(bad_theme("That theme file is missing or invalid"));
                }
                Some(id.clone())
            }
            _ => return Err(bad_theme("theme.setCustom expects a theme id or null")),
        };
        let next = state
            .settings
            .lock()
            .await
            .set_custom_theme(id)
            .await
            .map_err(|err| IpcError::new("settings-write-failed", err.to_string()))?;
        let value = json!(next);
        state.session_manager.emit_settings_changed(&value);
        Ok(value)
    })
}
