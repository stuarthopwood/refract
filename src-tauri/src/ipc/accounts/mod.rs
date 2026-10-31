// IPC handlers for `accounts.*` and `app.openReleaseNotes`. Refract never stores or reads a token.
// OMP exposes no sign-in command over rpc-ui, so sign-in and sign-out refuse outright.

mod handlers;
mod types;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, LazyLock, Mutex as StdMutex};

use tokio::sync::Mutex as AsyncMutex;

use crate::events;
use crate::github::cli::{self, GhAuthHostEntry, GhLoginFlow};
use crate::github::profile::{fetch_avatar, fetch_profile};
use crate::store::profile_cache::{ProfileCacheEntry, ProfileCacheStore};

use super::{AppState, Dispatcher, IpcError};

use types::{github_error_message, map_gh_error, map_io_error, now_epoch_millis};
pub use types::{AddFlowStatus, GitHubAccount, GitHubAddFlowProgress};

pub fn register(d: &mut Dispatcher) {
    d.register("accounts.github.list", handlers::accounts_github_list);
    d.register(
        "accounts.github.addStart",
        handlers::accounts_github_add_start,
    );
    d.register(
        "accounts.github.addCancel",
        handlers::accounts_github_add_cancel,
    );
    d.register("accounts.github.switch", handlers::accounts_github_switch);
    d.register(
        "accounts.github.signOut",
        handlers::accounts_github_sign_out,
    );
    d.register("accounts.omp.list", handlers::accounts_omp_list);
    d.register("accounts.omp.signIn", handlers::accounts_omp_sign_in);
    d.register("accounts.omp.signOut", handlers::accounts_omp_sign_out);
    d.register("accounts.omp.answer", handlers::accounts_omp_answer);
    d.register("app.openReleaseNotes", handlers::app_open_release_notes);
}

// ---- Module-level state ----

/// In-flight add-account flows, keyed by `flowId`, so `addCancel` can find the `GhLoginFlow`.
static ACTIVE_ADD_FLOWS: LazyLock<StdMutex<HashMap<String, Arc<GhLoginFlow>>>> =
    LazyLock::new(|| StdMutex::new(HashMap::new()));
static ADD_FLOW_SEQ: AtomicU64 = AtomicU64::new(0);

/// Serialises the ticket bump and the emit, so a stale round can never broadcast after a newer one.
/// The newest acquired ticket wins; the mutex makes the check-and-emit atomic on tokio's runtime.
static LATEST_BROADCAST_TICKET: StdMutex<u64> = StdMutex::new(0);

/// One store per data dir, opened lazily and reused. A failed open is not cached, so the next call retries.
static PROFILE_CACHE_STORES: LazyLock<
    AsyncMutex<HashMap<PathBuf, &'static AsyncMutex<ProfileCacheStore>>>,
> = LazyLock::new(|| AsyncMutex::new(HashMap::new()));

/// Accounts with a profile refresh already running; a second request for the same one is dropped.
static REFRESH_IN_FLIGHT: LazyLock<StdMutex<HashSet<String>>> =
    LazyLock::new(|| StdMutex::new(HashSet::new()));

struct RefreshGuard(String);

impl Drop for RefreshGuard {
    fn drop(&mut self) {
        if let Ok(mut set) = REFRESH_IN_FLIGHT.lock() {
            set.remove(&self.0);
        }
    }
}

async fn get_profile_cache(
    data_dir: &Path,
) -> std::io::Result<&'static AsyncMutex<ProfileCacheStore>> {
    let mut stores = PROFILE_CACHE_STORES.lock().await;
    if let Some(cell) = stores.get(data_dir) {
        return Ok(*cell);
    }
    let store = ProfileCacheStore::open(data_dir).await?;
    // Leaked once per data dir (one in production) so callers can hold a `'static` handle.
    let cell: &'static AsyncMutex<ProfileCacheStore> = Box::leak(Box::new(AsyncMutex::new(store)));
    stores.insert(data_dir.to_path_buf(), cell);
    Ok(cell)
}

fn acquire_broadcast_ticket() -> u64 {
    let mut ticket = LATEST_BROADCAST_TICKET
        .lock()
        .expect("LATEST_BROADCAST_TICKET mutex poisoned");
    *ticket += 1;
    *ticket
}

/// Drops the event if the window is gone; this bypasses `EventSink` on purpose.
fn broadcast_github_changed(
    app_handle: &Arc<StdMutex<Option<tauri::AppHandle>>>,
    accounts: &[GitHubAccount],
) {
    let handle = app_handle
        .lock()
        .expect("app_handle mutex poisoned")
        .clone();
    if let Some(app) = handle {
        events::emit(&app, events::ACCOUNTS_GITHUB_CHANGED, accounts.to_vec());
    }
}

/// Broadcasts only if `ticket` is still the newest, so a superseded result is dropped.
fn broadcast_github_changed_if_current(
    ticket: u64,
    app_handle: &Arc<StdMutex<Option<tauri::AppHandle>>>,
    accounts: &[GitHubAccount],
) {
    let latest = LATEST_BROADCAST_TICKET
        .lock()
        .expect("LATEST_BROADCAST_TICKET mutex poisoned");
    if ticket != *latest {
        return;
    }
    broadcast_github_changed(app_handle, accounts);
    // Keep `latest` locked until the emit returns, so no newer ticket can interleave.
}

fn broadcast_add_progress(
    app_handle: &Arc<StdMutex<Option<tauri::AppHandle>>>,
    payload: GitHubAddFlowProgress,
) {
    let handle = app_handle
        .lock()
        .expect("app_handle mutex poisoned")
        .clone();
    if let Some(app) = handle {
        events::emit(&app, events::ACCOUNTS_GITHUB_ADD_PROGRESS, payload);
    }
}

// ---- Orchestration shared by `handlers.rs` ----

/// Flattens `authStatus()` with cached display fields. Never refreshes, so it cannot recurse.
async fn read_github_accounts(data_dir: &Path) -> Result<Vec<GitHubAccount>, IpcError> {
    let hosts = cli::auth_status().await.map_err(map_gh_error)?;
    let cache_cell = get_profile_cache(data_dir).await.map_err(map_io_error)?;
    let cache = cache_cell.lock().await;
    Ok(types::to_github_accounts(&hosts, &cache))
}

/// Best-effort. A failed fetch leaves the cache untouched, and `force` bypasses the age check.
/// Returns whether the cache entry was written.
async fn refresh_profile_cache(
    cache_cell: &AsyncMutex<ProfileCacheStore>,
    host: &str,
    login: &str,
    force: bool,
) -> bool {
    if host != "github.com" {
        // Skip non-github.com hosts before reading any token.
        return false;
    }
    let key = format!("{host}/{login}");
    if !REFRESH_IN_FLIGHT
        .lock()
        .expect("REFRESH_IN_FLIGHT mutex poisoned")
        .insert(key.clone())
    {
        return false;
    }
    let _guard = RefreshGuard(key);
    let (previous_avatar_data_url, generation) = {
        let cache = cache_cell.lock().await;
        if !force && !types::is_profile_refresh_due(cache.get(host, login), now_epoch_millis()) {
            return false;
        }
        (
            cache
                .get(host, login)
                .and_then(|e| e.avatar_data_url.clone()),
            cache.delete_generation(),
        )
    };
    // The lock is released before the network calls, so a slow avatar fetch never blocks `list()`.
    let profile = match fetch_profile(host, login).await {
        Ok(profile) => profile,
        Err(_) => {
            log::debug!("accounts: opportunistic profile refresh failed for an account on {host}");
            return false;
        }
    };
    let mut avatar_data_url = previous_avatar_data_url;
    if let Some(avatar_url) = &profile.avatar_url {
        match fetch_avatar(avatar_url).await {
            Ok(data_url) => avatar_data_url = Some(data_url),
            Err(_) => {
                log::debug!("accounts: avatar refresh failed for an account on {host}, keeping the previously cached avatar");
            }
        }
    }
    let mut cache = cache_cell.lock().await;
    // A sign-out since the fetch began deleted the entry; writing now would resurrect it.
    if cache.delete_generation() != generation {
        return false;
    }
    cache
        .set(
            host,
            login,
            ProfileCacheEntry {
                display_name: profile.display_name,
                avatar_data_url,
                fetched_at: super::now_iso8601(),
            },
        )
        .await
        .is_ok()
}

/// Finds the new account by diffing `authStatus()` before and after, then refreshes its profile.
async fn finish_completed_add(
    data_dir: std::path::PathBuf,
    app_handle: Arc<StdMutex<Option<tauri::AppHandle>>>,
    hosts_before_start: Vec<GhAuthHostEntry>,
    ticket: u64,
) {
    let hosts_after = match cli::auth_status().await {
        Ok(hosts) => hosts,
        Err(err) => {
            log::error!(
                "accounts: failed to refresh GitHub accounts after a completed add flow: {}",
                err.message
            );
            return;
        }
    };
    let before: std::collections::HashSet<String> = hosts_before_start
        .iter()
        .map(|e| format!("{}/{}", e.host, e.login))
        .collect();
    let cache_cell = match get_profile_cache(&data_dir).await {
        Ok(cache_cell) => cache_cell,
        Err(err) => {
            log::error!(
                "accounts: failed to refresh GitHub accounts after a completed add flow: {err}"
            );
            return;
        }
    };
    for entry in hosts_after
        .iter()
        .filter(|e| e.host == "github.com" && !before.contains(&format!("{}/{}", e.host, e.login)))
    {
        let _ = refresh_profile_cache(cache_cell, &entry.host, &entry.login, true).await;
    }
    let accounts = {
        let cache = cache_cell.lock().await;
        types::to_github_accounts(&hosts_after, &cache)
    };
    broadcast_github_changed_if_current(ticket, &app_handle, &accounts);
}

/// The CLI mutation that `run_github_account_mutation` performs.
enum MutationKind {
    Switch,
    SignOut,
}

/// Validates the account pair before any CLI call, then runs the mutation and broadcasts.
async fn run_github_account_mutation(
    state: &AppState,
    host: &str,
    login: &str,
    kind: MutationKind,
) -> Result<Vec<GitHubAccount>, IpcError> {
    let hosts = cli::auth_status().await.map_err(map_gh_error)?;
    if !hosts.iter().any(|e| e.host == host && e.login == login) {
        return Err(IpcError::new(
            "account-not-found",
            github_error_message("account-not-found"),
        ));
    }
    match kind {
        MutationKind::Switch => {
            cli::auth_switch(host, login).await.map_err(map_gh_error)?;
        }
        MutationKind::SignOut => {
            cli::auth_logout(host, login).await.map_err(map_gh_error)?;
            // Drop the signed-out account's cached name and avatar. Best-effort, so errors are logged, not propagated.
            match get_profile_cache(&state.data_dir).await {
                Ok(cache_cell) => {
                    let mut cache = cache_cell.lock().await;
                    if let Err(err) = cache.delete(host, login).await {
                        log::debug!("accounts: failed to delete the cached profile for a signed-out account on {host}: {err}");
                    }
                }
                Err(err) => log::debug!("accounts: failed to delete the cached profile for a signed-out account on {host}: {err}"),
            }
        }
    }

    let ticket = acquire_broadcast_ticket();
    let projected_hosts = match kind {
        MutationKind::Switch => types::project_switch(&hosts, host, login),
        MutationKind::SignOut => types::project_sign_out(&hosts, host, login),
    };
    let cache_cell = get_profile_cache(&state.data_dir)
        .await
        .map_err(map_io_error)?;
    let projected = {
        let cache = cache_cell.lock().await;
        types::to_github_accounts(&projected_hosts, &cache)
    };
    broadcast_github_changed_if_current(ticket, &state.app_handle, &projected);

    let data_dir = state.data_dir.clone();
    let app_handle = state.app_handle.clone();
    tokio::spawn(async move {
        match read_github_accounts(&data_dir).await {
            Ok(actual) => broadcast_github_changed_if_current(ticket, &app_handle, &actual),
            Err(err) => log::error!(
                "accounts: failed to reconcile the GitHub account list after a mutation: {}",
                err.message
            ),
        }
    });

    Ok(projected)
}
