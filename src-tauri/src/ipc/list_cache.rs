// `listCache.read`, and the write-behind the list handlers call for the default open key only
// (FR-181 (b), (d)). A cache failure is logged and never reaches the renderer: the list handlers
// and the cold start both work without it.

use std::collections::HashSet;

use serde_json::{json, Value};

use crate::store::list_cache::{self, ListKind};

use super::{AppState, Dispatcher, HandlerFuture};

pub fn register(d: &mut Dispatcher) {
    d.register("listCache.read", list_cache_read);
}

/// `listCache.read()`: the cached default open lists, `null` for a list with nothing usable cached.
fn list_cache_read(state: AppState, _args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let cache = list_cache::read(&state.data_dir).await.unwrap_or_else(|err| {
            log::debug!("list cache: could not read it: {err}");
            list_cache::ListCache::default()
        });
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

/// Persists `result` as the last good default list. The caller has already checked the filters are
/// the default open ones (tab all, state open, no query or label, first page); this checks the
/// Projects cover the whole registry and none was skipped, then writes without delaying the reply.
pub async fn remember_default_list(
    state: &AppState,
    kind: ListKind,
    ids: &[String],
    result: &Value,
) {
    if !has_no_skipped(result) {
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
        if let Err(err) = list_cache::write(&data_dir, kind, result).await {
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
        assert!(covers_all_projects(&strings(&["b", "a"]), &strings(&["a", "b"])));
    }

    #[test]
    fn a_subset_or_superset_of_the_registry_is_not_the_default_set() {
        assert!(!covers_all_projects(&strings(&["a"]), &strings(&["a", "b"])));
        assert!(!covers_all_projects(&strings(&["a", "b", "c"]), &strings(&["a", "b"])));
    }

    #[test]
    fn no_projects_is_never_the_default_set() {
        assert!(!covers_all_projects(&[], &[]));
    }

    #[test]
    fn a_result_with_a_skipped_project_is_not_last_good() {
        assert!(has_no_skipped(&json!({ "skipped": [] })));
        assert!(!has_no_skipped(&json!({ "skipped": [{ "repositoryId": "a" }] })));
        assert!(!has_no_skipped(&json!({})));
    }
}
