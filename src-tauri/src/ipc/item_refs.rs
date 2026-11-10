// `itemRefs.lookup` (#1155): the Item card behind a `#123` / `owner/repo#123` hover. The Project only
// supplies the clone `gh` runs in and the default repository for a bare `#123`.

use serde_json::Value;

use crate::github::gh::owner_repo_for;
use crate::github::item_ref::{lookup_item, valid_item_number, RepoSlug};

use super::pull_requests::{map_gh_error, repo_path_for};
use super::{arg_str, invalid_argument, Dispatcher, HandlerFuture};

pub fn register(d: &mut Dispatcher) {
    d.register("itemRefs.lookup", item_refs_lookup);
}

fn item_refs_lookup(state: super::AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        const USAGE: &str =
            "itemRefs.lookup expects (repositoryId, owner | null, repo | null, number)";
        let repository_id = arg_str(&args, 0).ok_or_else(|| invalid_argument(USAGE))?;
        let number = args
            .get(3)
            .and_then(Value::as_u64)
            .filter(|&n| valid_item_number(n))
            .ok_or_else(|| invalid_argument(USAGE))?;
        let (repo_path, _) = repo_path_for(&state, repository_id).await?;
        let slug = match (arg_str(&args, 1), arg_str(&args, 2)) {
            (Some(owner), Some(repo)) => RepoSlug::parse(owner, repo).map_err(map_gh_error)?,
            (None, None) => {
                let (owner, repo) = owner_repo_for(&repo_path).await.map_err(map_gh_error)?;
                RepoSlug::parse(&owner, &repo).map_err(map_gh_error)?
            }
            _ => return Err(invalid_argument(USAGE)),
        };
        let card = lookup_item(&repo_path, &slug, number)
            .await
            .map_err(map_gh_error)?;
        Ok(serde_json::to_value(card).expect("item card is always JSON-serialisable"))
    })
}
