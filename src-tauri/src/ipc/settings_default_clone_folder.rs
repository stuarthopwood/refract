// IPC handler for `settings.setDefaultCloneFolder` (spec 054, issue #867, FR-035). Its own file
// to keep `settings.rs` under the 600-line cap (issue #806).
use std::path::Path;

use serde_json::Value;

use super::{invalid_argument, AppState, Dispatcher, HandlerFuture};

pub fn register(d: &mut Dispatcher) {
    d.register(
        "settings.setDefaultCloneFolder",
        settings_set_default_clone_folder,
    );
}

pub fn settings_set_default_clone_folder(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let path = match args.first() {
            None | Some(Value::Null) => None,
            Some(Value::String(raw)) => {
                let candidate = Path::new(raw);
                if !candidate.is_absolute() || !candidate.is_dir() {
                    return Err(invalid_argument(
                        "settings.setDefaultCloneFolder expects an absolute path to an existing folder, or null",
                    ));
                }
                Some(raw.clone())
            }
            Some(_) => {
                return Err(invalid_argument(
                    "settings.setDefaultCloneFolder expects a string path or null",
                ))
            }
        };
        let value = state
            .settings
            .lock()
            .await
            .set_default_clone_folder(path)
            .await
            .map_err(|err| super::IpcError::new("git-failed", err.to_string()))?;
        let value_json = serde_json::to_value(value).expect("Settings is always JSON-serialisable");
        state.session_manager.emit_settings_changed(&value_json);
        Ok(value_json)
    })
}
