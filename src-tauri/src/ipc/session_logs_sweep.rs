// One-off sweep of OMP session log folders left behind by Sessions deleted before `sessions.delete`
// removed them (#2161, FR-190). `sessionLogs.sweepPreview` lists them, `sessionLogs.sweepRun`
// deletes them; both are user-triggered. A folder is an orphan only when it is encoded from a path
// under a registered Project's worktrees root, no Session owns it, and no worktree that could have
// produced it still exists. Every delete goes through `remove_tree` against the sessions root.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

use super::conversations_delete::omp_sessions_root;
use super::conversations_size::tree_size_bytes;
use super::{AppState, Dispatcher, HandlerFuture, IpcError};
use crate::fs::remove_tree::remove_tree;
use crate::git::worktree_validity::comparable_path;
use crate::git::worktrees::worktrees_root;
use crate::store::registry::Registry;
use crate::usage::project_label::{encode_cwd, encoded_inner, normalise_path, resolve_dots};

pub fn register(d: &mut Dispatcher) {
    d.register("sessionLogs.sweepPreview", sweep_preview_handler);
    d.register("sessionLogs.sweepRun", sweep_run_handler);
}

/// One orphaned session log folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OrphanFolder {
    pub(crate) folder: String,
    pub(crate) size_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SweepPreview {
    pub(crate) folders: Vec<OrphanFolder>,
    pub(crate) total_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SweepRun {
    pub(crate) deleted: u64,
    pub(crate) failed: u64,
    pub(crate) bytes_freed: u64,
}

/// Folds every non-alphanumeric character to `-`, so a worktree directory name OMP encodes in a
/// way `encode_cwd` does not model still matches its folder and is kept rather than swept.
fn loose_key(text: &str) -> String {
    text.chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect()
}

/// `inner` is `key`, or continues it at a hyphen (a Session started in a subfolder).
fn covers(key: &str, inner: &str) -> bool {
    inner
        .strip_prefix(key)
        .is_some_and(|rest| rest.is_empty() || rest.starts_with('-'))
}

/// A registered Project whose repository folder is present: a missing one may be an unmounted
/// drive, which would make every worktree look gone.
struct ProjectRoot {
    key: String,
    /// `<worktrees parent>` holding this Project's root and any sibling Project's root.
    parent: PathBuf,
}

fn project_roots(registry: &Registry) -> Vec<ProjectRoot> {
    registry
        .repositories
        .iter()
        .filter(|r| Path::new(&r.path).file_name().is_some() && Path::new(&r.path).is_dir())
        .filter_map(|r| {
            let root = worktrees_root(Path::new(&r.path));
            let key = encode_cwd(&resolve_dots(&normalise_path(&root.to_string_lossy())));
            Some(ProjectRoot {
                key,
                parent: root.parent()?.to_path_buf(),
            })
        })
        .collect()
}

/// Loose keys of every worktree directory (`<parent>/<project>/<worktree>`) that exists. Sibling
/// Projects share the parent, and one Project's name can prefix another's, so the whole parent is
/// read rather than only the matching root.
fn existing_worktree_keys(roots: &[ProjectRoot]) -> Vec<String> {
    let parents: HashSet<&Path> = roots.iter().map(|r| r.parent.as_path()).collect();
    let mut keys = Vec::new();
    for parent in parents {
        let Ok(projects) = std::fs::read_dir(parent) else {
            continue;
        };
        for project in projects.flatten() {
            let Ok(worktrees) = std::fs::read_dir(project.path()) else {
                continue;
            };
            for worktree in worktrees.flatten() {
                let path = worktree.path();
                if path.is_dir() {
                    let normalised = resolve_dots(&normalise_path(&path.to_string_lossy()));
                    keys.push(loose_key(&encode_cwd(&normalised)));
                }
            }
        }
    }
    keys
}

/// Blocking: the orphan folders directly inside `sessions_root`, sorted by name.
pub(crate) fn find_orphans(registry: &Registry, sessions_root: &Path) -> Vec<OrphanFolder> {
    let roots = project_roots(registry);
    if roots.is_empty() {
        return Vec::new();
    }
    let owned: HashSet<String> = registry
        .sessions
        .iter()
        .filter_map(|s| s.session_dir.as_deref())
        .map(comparable_path)
        .collect();
    let worktree_keys = existing_worktree_keys(&roots);
    let Ok(entries) = std::fs::read_dir(sessions_root) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if !kind.is_dir() {
            continue;
        }
        let folder = entry.file_name().to_string_lossy().into_owned();
        let Some(inner) = encoded_inner(&folder) else {
            continue;
        };
        let under_a_root = roots.iter().any(|root| {
            inner
                .strip_prefix(&root.key)
                .is_some_and(|rest| rest.starts_with('-') && rest.len() > 1)
        });
        let path = entry.path();
        let loose_inner = loose_key(&inner);
        if !under_a_root
            || owned.contains(&comparable_path(&path.to_string_lossy()))
            || worktree_keys.iter().any(|key| covers(key, &loose_inner))
        {
            continue;
        }
        found.push(OrphanFolder {
            size_bytes: tree_size_bytes(&path),
            folder,
        });
    }
    found.sort_by(|a, b| a.folder.cmp(&b.folder));
    found
}

/// What `sweep_run_core` would delete; touches nothing.
pub(crate) async fn sweep_preview_core(registry: Registry, root: PathBuf) -> SweepPreview {
    let folders = tokio::task::spawn_blocking(move || find_orphans(&registry, &root))
        .await
        .unwrap_or_default();
    SweepPreview {
        total_bytes: folders.iter().map(|f| f.size_bytes).sum(),
        folders,
    }
}

/// Deletes each orphan folder; a failure on one is counted and the run carries on.
pub(crate) async fn sweep_run_core(registry: Registry, root: PathBuf) -> SweepRun {
    let preview = sweep_preview_core(registry, root.clone()).await;
    let mut run = SweepRun {
        deleted: 0,
        failed: 0,
        bytes_freed: 0,
    };
    for orphan in preview.folders {
        match remove_tree(&root.join(&orphan.folder), &root).await {
            Ok(()) => {
                run.deleted += 1;
                run.bytes_freed += orphan.size_bytes;
            }
            Err(err) => {
                run.failed += 1;
                log::warn!("sessionLogs.sweepRun: kept {}: {err}", orphan.folder);
            }
        }
    }
    run
}

async fn registry_and_root(state: &AppState) -> Result<(Registry, PathBuf), IpcError> {
    let root = omp_sessions_root()
        .ok_or_else(|| IpcError::new("delete-failed", "The home folder could not be found."))?;
    let registry = state.registry.lock().await.snapshot();
    Ok((registry, root))
}

fn sweep_preview_handler(state: AppState, _args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let (registry, root) = registry_and_root(&state).await?;
        let preview = sweep_preview_core(registry, root).await;
        Ok(serde_json::to_value(preview).expect("SweepPreview is always JSON-serialisable"))
    })
}

fn sweep_run_handler(state: AppState, _args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let (registry, root) = registry_and_root(&state).await?;
        let run = sweep_run_core(registry, root).await;
        Ok(serde_json::to_value(run).expect("SweepRun is always JSON-serialisable"))
    })
}

#[cfg(test)]
#[path = "session_logs_sweep.test.rs"]
mod tests;
