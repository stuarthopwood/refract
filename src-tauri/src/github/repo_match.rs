// Matches a repo to a Project by any remote URL; https/ssh/scp forms share one lowercase key (#867).

use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

use super::repo_ref::{is_valid_name, is_valid_owner};
use crate::git::git::git_raw;
use crate::store::registry::Repository;

const REMOTE_READ_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_PARALLEL_READS: usize = 8;

/// `owner/name` (lowercase) for a `github.com` remote URL, `None` for anything else.
pub fn normalise_remote(url: &str) -> Option<String> {
    let url = url.trim();
    let path = if let Some((_, rest)) = url.split_once("://") {
        let (authority, path) = rest.split_once('/')?;
        let host_port = authority.rsplit('@').next()?;
        let host = host_port.split(':').next()?;
        if !host.eq_ignore_ascii_case("github.com") {
            return None;
        }
        path
    } else {
        let (host_part, path) = url.split_once(':')?;
        let host = host_part.rsplit('@').next()?;
        if !host.eq_ignore_ascii_case("github.com") {
            return None;
        }
        path
    };
    let path = path.trim_matches('/');
    let mut segments = path.split('/');
    let (owner, name) = match (segments.next(), segments.next(), segments.next()) {
        (Some(owner), Some(name), None) => (owner, name),
        _ => return None,
    };
    let name = name.strip_suffix(".git").unwrap_or(name);
    if is_valid_owner(owner) && is_valid_name(name) {
        Some(format!("{owner}/{name}").to_ascii_lowercase())
    } else {
        None
    }
}

async fn project_remote_keys(path: &Path) -> Vec<String> {
    let result = git_raw(
        path,
        &["config", "--local", "--get-regexp", r"^remote\..*\.url$"],
        Some(REMOTE_READ_TIMEOUT),
    )
    .await;
    if result.code != 0 {
        return Vec::new();
    }
    result
        .stdout
        .lines()
        .filter_map(|line| line.split_once(' ').map(|(_, url)| url))
        .filter_map(normalise_remote)
        .collect()
}

/// Lowercase `owner/name` to Project id; reads run a few at a time to bound `git` spawns.
pub async fn project_index(repositories: &[Repository]) -> HashMap<String, String> {
    let mut index: HashMap<String, String> = HashMap::new();
    for chunk in repositories.chunks(MAX_PARALLEL_READS) {
        let mut set = tokio::task::JoinSet::new();
        for repository in chunk {
            let id = repository.id.clone();
            let path = repository.path.clone();
            set.spawn(async move { (id, project_remote_keys(Path::new(&path)).await) });
        }
        while let Some(joined) = set.join_next().await {
            let Ok((id, keys)) = joined else { continue };
            for key in keys {
                index.entry(key).or_insert_with(|| id.clone());
            }
        }
    }
    index
}
