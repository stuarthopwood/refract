// IPC handlers for `accounts.*` (`contracts/ipc.md` "GitHub accounts", "OMP provider sign-in")
// and `app.openReleaseNotes` (lane R9, issue #792), porting `src/main/ipc/accounts.ts`.
//
// GitHub half: lists/adds/switches/signs out GitHub CLI accounts via `github::cli`, enriching
// each with `profileCache.json`'s cached display fields (`github::profile`,
// `store::profile_cache`) and refreshing that cache opportunistically in the background
// (research.md decision 5) -- `list()` itself never blocks on a live fetch; it always answers
// from whatever is already cached, `None` included (the renderer falls back to login/initials).
//
// OMP half: research.md decision 6 / docs/spike/FINDINGS.md item 43 confirmed omp 18.5.1 exposes
// no `/login`/`/logout` command over rpc-ui at all. `signIn`/`signOut`/`answer` unconditionally
// refuse (`unsupported`/`not-found`) rather than driving a flow that cannot exist; only `list()`
// does a real, read-only scratch-`OmpProcess` probe (`omp::login_providers`).
//
// No token is ever stored or read by Refract (spec 003 FR-027, constitution V): every GitHub
// operation goes through the developer's own signed-in `gh` (`github::cli`); subprocess
// arguments are arrays, never shell strings (`github::cli`'s own discipline).
//
// Split across this directory (issue #806, 600-line-per-file cap, matching `ipc::pull_requests`'s
// own `mod.rs`/`mapping.rs`/`handlers.rs` layout): `types.rs` keeps the wire shapes and every pure
// function (flattening, projection, staleness, error-message mapping); this file keeps
// registration, the module-level state (in-flight add flows, the broadcast-ordering ticket, the
// lazily opened profile cache), and the orchestration every handler in `handlers.rs` calls into.

mod handlers;
mod types;

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex as StdMutex};

use tokio::sync::{Mutex as AsyncMutex, OnceCell};

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

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/// Tracks every add-account flow currently in flight, keyed by the `flowId` handed back from
/// `addStart`, so a later `addCancel(flowId)` can find the right `GhLoginFlow` to cancel.
static ACTIVE_ADD_FLOWS: LazyLock<StdMutex<HashMap<String, Arc<GhLoginFlow>>>> =
    LazyLock::new(|| StdMutex::new(HashMap::new()));
static ADD_FLOW_SEQ: AtomicU64 = AtomicU64::new(0);

/// GateCode008 MEDIUM "broadcast ordering": every reconcile/refresh round that will eventually
/// broadcast acquires a ticket via `acquire_broadcast_ticket` right before that round's own async
/// work begins -- for `list()` that is the call itself; for a completed add flow and for
/// switch/signOut it is only once the CLI mutation has already settled and the post-mutation
/// reconcile is about to start. Whichever round's ticket was acquired most recently always wins,
/// so an earlier round's now-stale result can never overwrite it.
static LATEST_BROADCAST_TICKET: AtomicU64 = AtomicU64::new(0);

/// Opened lazily on first use and reused afterward (the same single-store-instance pattern
/// `RegistryStore`/`SettingsStore` get via `AppState`, just owned by this module instead, since
/// nothing else in the crate needs the GitHub display cache). `get_or_try_init` never caches a
/// rejected open forever: a failed attempt leaves the cell uninitialised, so the very next call
/// retries `ProfileCacheStore::open` instead of re-awaiting a dead result.
static PROFILE_CACHE_STORE: OnceCell<AsyncMutex<ProfileCacheStore>> = OnceCell::const_new();

async fn get_profile_cache(
    data_dir: &Path,
) -> std::io::Result<&'static AsyncMutex<ProfileCacheStore>> {
    PROFILE_CACHE_STORE
        .get_or_try_init(|| async { ProfileCacheStore::open(data_dir).await.map(AsyncMutex::new) })
        .await
}

fn acquire_broadcast_ticket() -> u64 {
    LATEST_BROADCAST_TICKET.fetch_add(1, Ordering::SeqCst) + 1
}

/// Never fails: a destroyed-or-not-yet-created window simply drops the event, mirroring
/// `events::EventSink::send`'s own defensive stance -- this module reaches `AppState::app_handle`
/// directly rather than through an `EventSink` (no `SessionManager` state is needed here).
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

/// Only broadcasts when `ticket` is still the most recently acquired one -- a re-read or
/// reconcile holding an older ticket has been superseded by a later mutation/list and must drop
/// its now-stale result instead of overwriting what the newer operation already broadcast.
fn broadcast_github_changed_if_current(
    ticket: u64,
    app_handle: &Arc<StdMutex<Option<tauri::AppHandle>>>,
    accounts: &[GitHubAccount],
) {
    if ticket != LATEST_BROADCAST_TICKET.load(Ordering::SeqCst) {
        return;
    }
    broadcast_github_changed(app_handle, accounts);
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

// ---------------------------------------------------------------------------
// Orchestration shared by `handlers.rs`
// ---------------------------------------------------------------------------

/// Flattens `authStatus()` with `profileCache.json`'s cached display fields -- the pure,
/// no-refresh read used for every re-read that must NOT itself kick off another refresh round:
/// the background-refresh re-read, a switch/sign-out's post-mutation reconcile, and the
/// completed-add path. Only the explicit `list()` path (`handlers::accounts_github_list`) ever
/// refreshes.
async fn read_github_accounts(data_dir: &Path) -> Result<Vec<GitHubAccount>, IpcError> {
    let hosts = cli::auth_status().await.map_err(map_gh_error)?;
    let cache_cell = get_profile_cache(data_dir).await.map_err(map_io_error)?;
    let cache = cache_cell.lock().await;
    Ok(types::to_github_accounts(&hosts, &cache))
}

/// Best-effort: a failed profile fetch leaves the cache entirely untouched (data-model.md "a
/// failed or skipped fetch... leaves the previous entry untouched"); a failed avatar fetch after
/// a successful profile fetch keeps the previously cached avatar rather than clearing it. Never
/// fails -- callers fire this and forget it. `force` bypasses `is_profile_refresh_due` for a
/// login just added via `finish_completed_add`, which must always get its first fetch regardless
/// of any (nonexistent) prior entry's age.
async fn refresh_profile_cache(
    cache_cell: &AsyncMutex<ProfileCacheStore>,
    host: &str,
    login: &str,
    force: bool,
) {
    if host != "github.com" {
        // GateSec008 HIGH / GateCode008 CRITICAL: skip entirely rather than attempt-then-catch --
        // `fetch_profile` itself refuses any non-github.com host too, but a GitHub Enterprise
        // account must never even have its token read for this.
        return;
    }
    {
        let cache = cache_cell.lock().await;
        if !force && !types::is_profile_refresh_due(cache.get(host, login), now_epoch_millis()) {
            return;
        }
    }
    let profile = match fetch_profile(host, login).await {
        Ok(profile) => profile,
        Err(_) => {
            log::debug!("accounts: opportunistic profile refresh failed for an account on {host}");
            return;
        }
    };
    let mut cache = cache_cell.lock().await;
    let mut avatar_data_url = cache
        .get(host, login)
        .and_then(|e| e.avatar_data_url.clone());
    if let Some(avatar_url) = &profile.avatar_url {
        match fetch_avatar(avatar_url).await {
            Ok(data_url) => avatar_data_url = Some(data_url),
            Err(_) => {
                log::debug!("accounts: avatar refresh failed for an account on {host}, keeping the previously cached avatar");
            }
        }
    }
    let _ = cache
        .set(
            host,
            login,
            ProfileCacheEntry {
                display_name: profile.display_name,
                avatar_data_url,
                fetched_at: super::now_iso8601(),
            },
        )
        .await;
}

/// A completed add flow's `authStatus()` snapshot vs. the one taken just before the flow started
/// is the only way to learn which host/login is new (`GhLoginFlow` reports no login); refreshes
/// that account's profile cache (GateCode008 MEDIUM "a newly added account never gets its
/// name/avatar this session") and then broadcasts, under `ticket` so a later mutation always wins
/// over this if one started since. Never fails -- the caller fires this and forgets it.
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
        refresh_profile_cache(cache_cell, &entry.host, &entry.login, true).await;
    }
    let accounts = {
        let cache = cache_cell.lock().await;
        types::to_github_accounts(&hosts_after, &cache)
    };
    broadcast_github_changed_if_current(ticket, &app_handle, &accounts);
}

/// Which CLI mutation `run_github_account_mutation` below performs; folds `switch`/`signOut`'s
/// shared validate-then-broadcast body (ported from `runGithubAccountMutation`) into one function
/// without generic closures over async fns.
enum MutationKind {
    Switch,
    SignOut,
}

/// Shared body of `switch`/`signOut`: validate the pair against the current `authStatus()` list
/// (`contracts/ipc.md` "`account-not-found`") before ever invoking the CLI, run the mutation, then
/// return and broadcast the refreshed list. A background re-read then reconciles with the CLI's
/// real state and broadcasts any difference -- both broadcasts share one ticket (GateCode008
/// MEDIUM "broadcast ordering"), so a later mutation's own ticket always wins over this one's
/// now-stale reconcile.
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
            // GateSec008 LOW: once sign-out has actually succeeded, also drop that account's
            // now-stale display name/avatar so it does not outlive the account. Best-effort,
            // like the ported TS: a cache-store hiccup here must not undo an already-successful
            // sign-out, so it is logged and swallowed, never propagated.
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
