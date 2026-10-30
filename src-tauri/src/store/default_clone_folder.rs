// "Default clone folder" setting (#867).
use std::path::Path;

use serde_json::{Map, Value};

use super::{Settings, SettingsStore};

pub(super) const KEY: &str = "defaultCloneFolder";

/// An absolute path to an existing directory, or `None`: an absent, non-string, relative or
/// vanished value reads as unset.
pub(super) fn parse(object: &Map<String, Value>) -> Option<String> {
    let value = object.get(KEY)?.as_str()?;
    let path = Path::new(value);
    (path.is_absolute() && path.is_dir()).then(|| value.to_string())
}

pub(super) fn write(map: &mut Map<String, Value>, value: &Option<String>) {
    if let Some(path) = value {
        map.insert(KEY.to_string(), Value::String(path.clone()));
    }
}

impl SettingsStore {
    /// `settings.setDefaultCloneFolder(path | null)`; the caller has already validated `path`.
    pub async fn set_default_clone_folder(
        &mut self,
        path: Option<String>,
    ) -> std::io::Result<Settings> {
        let next = Settings {
            default_clone_folder: path,
            ..self.data.clone()
        };
        self.persist_whole(next).await
    }
}
