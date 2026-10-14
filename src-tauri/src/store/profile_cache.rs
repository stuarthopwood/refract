// Port of `src/main/store/profileCache.ts`: holds `profileCache.json`, the revalidated GitHub
// display cache (data-model.md "profileCache.json"). Never holds a GitHub access token
// (FR-012) -- only the two display fields derived from a one-time profile/avatar fetch.
//
// `ProfileCache`/`ProfileCacheEntry` are the canonical shapes from `shared/model.ts` lines
// 574-583, ported field for field (camelCase on the wire via serde).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::atomic_json::{read_json_file, write_json_file};

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
}

impl ProfileCacheStore {
    pub async fn open(dir: &Path) -> std::io::Result<Self> {
        let file = dir.join("profileCache.json");
        let data = read_json_file(&file, || ProfileCache {
            version: 1,
            accounts: HashMap::new(),
        })
        .await?;
        Ok(Self { file, data })
    }

    /// Returns the cached entry for `host/login`, or `None` if never successfully fetched.
    pub fn get(&self, host: &str, login: &str) -> Option<&ProfileCacheEntry> {
        self.data.accounts.get(&format!("{host}/{login}"))
    }

    /// Writes a fresh entry for `host/login` (data-model.md "an entry is written whenever a fetch
    /// for that `host/login` succeeds"); a failed or skipped fetch must simply not call this.
    pub async fn set(
        &mut self,
        host: &str,
        login: &str,
        entry: ProfileCacheEntry,
    ) -> std::io::Result<()> {
        self.data
            .accounts
            .insert(format!("{host}/{login}"), entry);
        write_json_file(&self.file, &self.data).await
    }

    /// Deletes `host/login`'s cached entry, if any (GateSec008 LOW: a signed-out account must not
    /// leave its display name/avatar behind in profileCache.json). No-op (and no write) when
    /// there was nothing cached for that pair.
    pub async fn delete(&mut self, host: &str, login: &str) -> std::io::Result<()> {
        let key = format!("{host}/{login}");
        if self.data.accounts.remove(&key).is_none() {
            return Ok(());
        }
        write_json_file(&self.file, &self.data).await
    }
}
