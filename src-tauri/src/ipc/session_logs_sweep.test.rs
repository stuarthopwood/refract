// Orphan sweep over temp dirs only; never a real `~/.omp`. Folder names are built with the same
// encoding the sweep reads, so a test fails if either side drifts.

use std::path::{Path, PathBuf};

use super::*;
use crate::git::worktrees::worktrees_root;
use crate::store::registry::{Repository, Session};

struct Rig {
    registry: Registry,
    root: PathBuf,
    worktrees: PathBuf,
}

fn session_row(id: &str, dir: &Path) -> Session {
    Session {
        id: id.to_string(),
        kind: crate::store::session_kind::SessionKind::Project,
        repository_id: Some("repo".to_string()),
        name: "test".to_string(),
        branch: Some(format!("feat/sweep-{id}")),
        base_branch: Some("main".to_string()),
        worktree_path: Some(format!("C:/nowhere/worktree-{id}")),
        session_dir: Some(dir.to_string_lossy().into_owned()),
        current_conversation: None,
        last_message_count: None,
        last_model: None,
        last_thinking_level: None,
        created_at: "2026-01-01T00:00:00.000Z".to_string(),
        last_activity_at: "2026-01-01T00:00:00.000Z".to_string(),
        archived_at: None,
        hidden_at: None,
        paused_held: None,
        current_turn_subagents: None,
        stopped_on_request_conversation: None,
        stopped_on_request_at_size: None,
        pinned_model: false,
        origin_issue: None,
        parent_session_id: None,
    }
}

/// A registry with one Project (`repo`, present on disk) and no Sessions.
fn rig() -> Rig {
    let scratch = crate::test_scratch::path(format!("sweep-{}", uuid::Uuid::new_v4()));
    let repo = scratch.join("repo");
    let root = scratch.join("sessions-root");
    std::fs::create_dir_all(&repo).unwrap();
    std::fs::create_dir_all(&root).unwrap();
    let worktrees = worktrees_root(&repo);
    std::fs::create_dir_all(&worktrees).unwrap();
    let registry = Registry {
        version: 1,
        repositories: vec![Repository {
            id: "repo".to_string(),
            path: repo.to_string_lossy().into_owned(),
            name: "repo".to_string(),
            default_branch: "main".to_string(),
            added_at: "2026-01-01T00:00:00.000Z".to_string(),
            color: None,
        }],
        sessions: Vec::new(),
    };
    Rig {
        registry,
        root,
        worktrees,
    }
}

/// The folder OMP names for a Session started in `cwd`: `--<encoded cwd>--`.
fn folder_for(cwd: &Path) -> String {
    let encoded = encode_cwd(&resolve_dots(&normalise_path(&cwd.to_string_lossy())));
    format!("--{encoded}--")
}

/// Creates a session log folder holding one Conversation file and returns its path.
fn log_folder(root: &Path, name: &str) -> PathBuf {
    let dir = root.join(name);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("2026-01-01T00-00-00-000Z_a.jsonl"), "{}\n").unwrap();
    dir
}

fn names(orphans: &[OrphanFolder]) -> Vec<&str> {
    orphans.iter().map(|o| o.folder.as_str()).collect()
}

#[test]
fn a_true_orphan_is_listed() {
    let rig = rig();
    let name = folder_for(&rig.worktrees.join("gone-otter"));
    log_folder(&rig.root, &name);

    let found = find_orphans(&rig.registry, &rig.root);

    assert_eq!(names(&found), vec![name.as_str()]);
    assert!(found[0].size_bytes > 0);
}

#[test]
fn a_folder_a_registry_session_owns_is_kept() {
    let mut rig = rig();
    let name = folder_for(&rig.worktrees.join("gone-otter"));
    let dir = log_folder(&rig.root, &name);
    rig.registry.sessions.push(session_row("owner", &dir));

    assert!(find_orphans(&rig.registry, &rig.root).is_empty());
}

#[test]
fn a_folder_whose_worktree_still_exists_is_kept() {
    let rig = rig();
    let worktree = rig.worktrees.join("live-otter");
    std::fs::create_dir_all(&worktree).unwrap();
    log_folder(&rig.root, &folder_for(&worktree));

    assert!(find_orphans(&rig.registry, &rig.root).is_empty());
}

#[test]
fn a_plain_omp_folder_outside_every_worktrees_root_is_untouched() {
    let rig = rig();
    let outside = rig
        .worktrees
        .parent()
        .unwrap()
        .join("not-a-project")
        .join("x");
    log_folder(&rig.root, &folder_for(&outside));
    log_folder(&rig.root, "--c--users--someone--");
    log_folder(&rig.root, "plain-folder");

    assert!(find_orphans(&rig.registry, &rig.root).is_empty());
}

#[test]
fn nothing_is_an_orphan_when_no_project_is_registered() {
    let mut rig = rig();
    log_folder(&rig.root, &folder_for(&rig.worktrees.join("gone-otter")));
    rig.registry.repositories.clear();

    assert!(find_orphans(&rig.registry, &rig.root).is_empty());
}

#[test]
fn a_project_missing_from_disk_sweeps_nothing() {
    let rig = rig();
    log_folder(&rig.root, &folder_for(&rig.worktrees.join("gone-otter")));
    std::fs::remove_dir_all(&rig.registry.repositories[0].path).unwrap();

    assert!(find_orphans(&rig.registry, &rig.root).is_empty());
}

#[tokio::test]
async fn preview_lists_the_orphan_and_deletes_nothing() {
    let rig = rig();
    let name = folder_for(&rig.worktrees.join("gone-otter"));
    let dir = log_folder(&rig.root, &name);

    let preview = sweep_preview_core(rig.registry.clone(), rig.root.clone()).await;

    assert_eq!(names(&preview.folders), vec![name.as_str()]);
    assert_eq!(preview.total_bytes, preview.folders[0].size_bytes);
    assert!(dir.join("2026-01-01T00-00-00-000Z_a.jsonl").exists());
}

#[tokio::test]
async fn run_removes_only_the_orphan() {
    let mut rig = rig();
    let orphan = log_folder(&rig.root, &folder_for(&rig.worktrees.join("gone-otter")));
    let owned = log_folder(&rig.root, &folder_for(&rig.worktrees.join("owned-fox")));
    rig.registry.sessions.push(session_row("owner", &owned));
    let live = rig.worktrees.join("live-hawk");
    std::fs::create_dir_all(&live).unwrap();
    let live_logs = log_folder(&rig.root, &folder_for(&live));
    let plain = log_folder(&rig.root, "--c--users--someone--");

    let run = sweep_run_core(rig.registry.clone(), rig.root.clone()).await;

    assert_eq!((run.deleted, run.failed), (1, 0));
    assert!(run.bytes_freed > 0);
    assert!(!orphan.exists());
    assert!(owned.exists() && live_logs.exists() && plain.exists());
}
