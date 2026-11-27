// `listCache.read`, and the write-behind the list handlers call for the default open key only
// (FR-181 (b), (d)). A cache failure is logged and never reaches the renderer: the list handlers
// and the cold start both work without it.

use std::collections::HashSet;

use serde_json::{json, Value};

use crate::github::cli;
use crate::store::list_cache::{self, CacheAccount, ListKind};

use super::{AppState, Dispatcher, HandlerFuture};

pub fn register(d: &mut Dispatcher) {
    d.register("listCache.read", list_cache_read);
}

/// The active GitHub account the list handlers' `gh` calls run as: the active one on github.com,
/// else the first active one. `None` when `gh` cannot say, so nothing is read or written.
pub(crate) async fn active_account() -> Option<CacheAccount> {
    let mut entries = cli::auth_status().await.ok()?;
    entries.retain(|entry| entry.active);
    let index = entries
        .iter()
        .position(|entry| entry.host == "github.com")
        .unwrap_or(0);
    (index < entries.len()).then(|| {
        let entry = entries.swap_remove(index);
        CacheAccount {
            host: entry.host,
            login: entry.login,
        }
    })
}

/// `listCache.read()`: the cached default open lists for the active account, `null` for a list
/// with nothing usable cached.
fn list_cache_read(state: AppState, _args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let cache = match active_account().await {
            Some(account) => list_cache::read(&state.data_dir, &account)
                .await
                .unwrap_or_else(|err| {
                    log::debug!("list cache: could not read it: {err}");
                    list_cache::ListCache::default()
                }),
            None => list_cache::ListCache::default(),
        };
        Ok(json!({ "pullRequests": cache.pull_requests, "issues": cache.issues }))
    })
}

/// True when `ids` is exactly the registered Projects: the default list covers all of them.
fn covers_all_projects(ids: &[String], registered: &[String]) -> bool {
    if ids.is_empty() {
        return false;
    }
    let chosen: HashSet<&str> = ids.iter().map(String::as_str).collect();
    let all: HashSet<&str> = registered.iter().map(String::as_str).collect();
    chosen == all
}

/// True when the result lists every Project it was asked for; a partial list is not "last good".
fn has_no_skipped(result: &Value) -> bool {
    result
        .get("skipped")
        .and_then(Value::as_array)
        .is_some_and(Vec::is_empty)
}

/// The account to write under: the one the fetch ran as, only while `gh` still reports it active.
/// A switch during the fetch, or `gh` not answering, means the rows may belong to another account.
fn account_to_write(
    fetched_as: Option<CacheAccount>,
    active_now: Option<CacheAccount>,
) -> Option<CacheAccount> {
    fetched_as.filter(|account| active_now.as_ref() == Some(account))
}

/// Persists `result` as the last good default list. The caller has already checked the filters are
/// the default open ones (tab all, state open, no query or label, first page); this checks the
/// Projects cover the whole registry and none was skipped, then writes without delaying the reply.
/// `epoch` and `account` are `list_cache::epoch()` and `active_account()` from before the fetch: an
/// account change since then drops the write.
pub async fn remember_default_list(
    state: &AppState,
    kind: ListKind,
    ids: &[String],
    result: &Value,
    epoch: u64,
    account: Option<CacheAccount>,
) {
    if account.is_none() || !has_no_skipped(result) {
        return;
    }
    let registered: Vec<String> = state
        .registry
        .lock()
        .await
        .snapshot()
        .repositories
        .into_iter()
        .map(|repository| repository.id)
        .collect();
    if !covers_all_projects(ids, &registered) {
        return;
    }
    let data_dir = state.data_dir.clone();
    let result = result.clone();
    tokio::spawn(async move {
        let Some(account) = account_to_write(account, active_account().await) else {
            return;
        };
        if let Err(err) = list_cache::write(&data_dir, kind, result, &account, epoch).await {
            log::debug!("list cache: could not write it: {err}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(ids: &[&str]) -> Vec<String> {
        ids.iter().map(|id| id.to_string()).collect()
    }

    #[test]
    fn all_registered_projects_in_any_order_is_the_default_set() {
        assert!(covers_all_projects(
            &strings(&["b", "a"]),
            &strings(&["a", "b"])
        ));
    }

    #[test]
    fn a_subset_or_superset_of_the_registry_is_not_the_default_set() {
        assert!(!covers_all_projects(
            &strings(&["a"]),
            &strings(&["a", "b"])
        ));
        assert!(!covers_all_projects(
            &strings(&["a", "b", "c"]),
            &strings(&["a", "b"])
        ));
    }

    #[test]
    fn no_projects_is_never_the_default_set() {
        assert!(!covers_all_projects(&[], &[]));
    }

    #[test]
    fn a_result_with_a_skipped_project_is_not_last_good() {
        assert!(has_no_skipped(&json!({ "skipped": [] })));
        assert!(!has_no_skipped(
            &json!({ "skipped": [{ "repositoryId": "a" }] })
        ));
        assert!(!has_no_skipped(&json!({})));
    }

    fn account(login: &str) -> CacheAccount {
        CacheAccount {
            host: "github.com".to_string(),
            login: login.to_string(),
        }
    }

    #[test]
    fn a_write_is_skipped_when_the_active_account_changed_during_the_fetch() {
        assert_eq!(
            account_to_write(Some(account("a")), Some(account("a"))),
            Some(account("a"))
        );
        assert_eq!(
            account_to_write(Some(account("a")), Some(account("b"))),
            None
        );
        assert_eq!(account_to_write(Some(account("a")), None), None);
        assert_eq!(account_to_write(None, Some(account("a"))), None);
    }
}
