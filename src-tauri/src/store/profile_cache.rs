// `profileCache.json`: the revalidated GitHub display cache. Never holds an access token, only
// the display fields from a one-time profile/avatar fetch.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::atomic_json::{read_json_file, write_json_file};
use crate::github::profile::MAX_DISPLAY_NAME_CHARS;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileCacheEntry {
    /// `null` falls back to the login everywhere a name would show.
    pub display_name: Option<String>,
    /// Validated `data:image/png|jpeg;base64,...`; `None` = show initials.
    pub avatar_data_url: Option<String>,
    /// ISO 8601; the moment this entry was last successfully refreshed.
    pub fetched_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileCache {
    pub version: u32,
    /// Keyed by `${host}/${login}`, e.g. `"github.com/stuarthopwood"`.
    pub accounts: HashMap<String, ProfileCacheEntry>,
}

pub struct ProfileCacheStore {
    file: PathBuf,
    data: ProfileCache,
    /// Bumped on every `delete`, so an in-flight refresh can tell its fetch predates a sign-out.
    delete_generation: u64,
}

/// Drops fields a hand-edited or corrupt file could use to inject a non-image URL or a huge name.
fn sanitize_entry(entry: &mut ProfileCacheEntry) {
    if entry
        .avatar_data_url
        .as_deref()
        .is_some_and(|url| !url.starts_with("data:image/"))
    {
        entry.avatar_data_url = None;
    }
    if let Some(name) = entry.display_name.as_mut() {
        if name.chars().count() > MAX_DISPLAY_NAME_CHARS {
            *name = name.chars().take(MAX_DISPLAY_NAME_CHARS).collect();
        }
    }
}

impl ProfileCacheStore {
    pub async fn open(dir: &Path) -> std::io::Result<Self> {
        let file = dir.join("profileCache.json");
        let mut data = read_json_file(&file, || ProfileCache {
            version: 1,
            accounts: HashMap::new(),
        })
        .await?;
        data.accounts.values_mut().for_each(sanitize_entry);
        Ok(Self {
            file,
            data,
            delete_generation: 0,
        })
    }

    pub fn delete_generation(&self) -> u64 {
        self.delete_generation
    }

    /// Returns the cached entry for `host/login`, or `None` if never successfully fetched.
    pub fn get(&self, host: &str, login: &str) -> Option<&ProfileCacheEntry> {
        self.data.accounts.get(&format!("{host}/{login}"))
    }

    /// Writes a fresh entry for `host/login`; call only after a successful fetch.
    pub async fn set(
        &mut self,
        host: &str,
        login: &str,
        mut entry: ProfileCacheEntry,
    ) -> std::io::Result<()> {
        sanitize_entry(&mut entry);
        self.data.accounts.insert(format!("{host}/{login}"), entry);
        write_json_file(&self.file, &self.data).await
    }

    /// Deletes `host/login`'s entry so a signed-out account leaves no name/avatar behind; no write
    /// when nothing was cached.
    pub async fn delete(&mut self, host: &str, login: &str) -> std::io::Result<()> {
        let key = format!("{host}/{login}");
        self.delete_generation += 1;
        if self.data.accounts.remove(&key).is_none() {
            return Ok(());
        }
        write_json_file(&self.file, &self.data).await
    }
}
