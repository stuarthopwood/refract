// Tests for `list_directory.rs`, kept in a sibling file for the 600-line cap.

use super::*;
use crate::git::test_support::{init_repo, run_git};

fn is_ci() -> bool {
    std::env::var("CI").is_ok()
}

/// Creates a junction. Panics under CI rather than skipping, so a skipped test never passes silently.
fn make_junction(target_dir: &std::path::Path, link: &std::path::Path) {
    let status = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(link)
        .arg(target_dir)
        .status();
    let ok = matches!(status, Ok(s) if s.success());
    if !ok {
        if is_ci() {
            panic!("junction creation failed in CI: mklink /J {link:?} {target_dir:?}");
        }
        eprintln!("skipping junction-based test: mklink refused (sandbox restriction, not CI)");
    }
}

fn fixture() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("refract-listdir-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(dir.join("sub")).unwrap();
    std::fs::write(dir.join("sub").join("file.txt"), b"hi").unwrap();
    std::fs::create_dir_all(dir.join(".git")).unwrap();
    std::fs::write(dir.join(".git").join("HEAD"), b"ref: refs/heads/main").unwrap();
    dir
}

#[tokio::test]
async fn dot_git_requested_as_typed_is_rejected() {
    let session = format!("s-{}", uuid::Uuid::new_v4());
    let root = fixture();
    let result = resolve_list_target(&session, None, &root, ".git").await;
    assert!(matches!(result, Err(ResolveReason::OutsideWorktree)));
}

#[tokio::test]
async fn dot_git_nested_path_as_typed_is_rejected() {
    let session = format!("s-{}", uuid::Uuid::new_v4());
    let root = fixture();
    let result = resolve_list_target(&session, None, &root, ".git/HEAD").await;
    assert!(matches!(result, Err(ResolveReason::OutsideWorktree)));
}

#[tokio::test]
async fn dot_git_reached_via_an_8_3_short_name_alias_is_rejected_post_realpath() {
    // The `.git` alias may be absent if 8.3 generation is disabled, so the assertion is conditional.
    let session = format!("s-{}", uuid::Uuid::new_v4());
    let root = fixture();
    let alias_exists = std::fs::metadata(root.join("GIT~1")).is_ok();
    if !alias_exists {
        if is_ci() {
            panic!("GIT~1 8.3 alias does not exist in CI; 8.3 name generation may be disabled on this runner's volume");
        }
        eprintln!("skipping 8.3-alias test: GIT~1 does not exist on this volume (8.3 generation disabled?)");
        return;
    }
    let result = resolve_list_target(&session, None, &root, "GIT~1/HEAD").await;
    assert_eq!(
        result.unwrap_err(),
        ResolveReason::OutsideWorktree,
        "must never resolve into .git via a short-name alias"
    );
}

#[tokio::test]
async fn a_valid_worktree_with_its_tracked_file_removed_lists_as_genuinely_empty() {
    let session = format!("s-{}", uuid::Uuid::new_v4());
    let repo = init_repo().await;
    let worktree = repo.with_file_name(format!("wt-{}", uuid::Uuid::new_v4()));
    run_git(
        &repo,
        &[
            "worktree",
            "add",
            "-b",
            "valid-empty-branch",
            worktree.to_str().unwrap(),
            "main",
        ],
    )
    .await;
    // Removes the tracked file so the root lists empty while the `.git` pointer still proves registration.
    tokio::fs::remove_file(worktree.join("README.md"))
        .await
        .unwrap();
    let result = list_directory_entries(&session, Some(&repo), &worktree, "").await;
    match result {
        Ok(ok) => assert_eq!(
            ok.entries.len(),
            0,
            "the only tracked file was removed from disk"
        ),
        Err(_) => panic!("a validly registered worktree must not report worktree-missing"),
    }
}

#[tokio::test]
async fn an_unregistered_orphaned_folder_is_worktree_missing_not_empty() {
    // Issue #729: an unregistered folder must report `worktree-missing`, never an empty listing.
    let session = format!("s-{}", uuid::Uuid::new_v4());
    let repo = init_repo().await;
    let orphan =
        std::env::temp_dir().join(format!("refract-listdir-orphan-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&orphan).unwrap();
    let result = list_directory_entries(&session, Some(&repo), &orphan, "").await;
    assert!(
        matches!(result, Err(ListDirectoryError::WorktreeMissing)),
        "an unregistered folder must be worktree-missing, not a successful empty listing"
    );
}

#[tokio::test]
async fn entries_beyond_the_cap_are_truncated_and_counted() {
    let session = format!("s-{}", uuid::Uuid::new_v4());
    let root = std::env::temp_dir().join(format!("refract-listdir-cap-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    for i in 0..(MAX_ENTRIES_PER_DIRECTORY + 200) {
        std::fs::write(root.join(format!("f{i:05}.txt")), b"x").unwrap();
    }
    let result = list_directory_entries(&session, None, &root, "")
        .await
        .expect("listing should succeed");
    assert_eq!(result.entries.len(), MAX_ENTRIES_PER_DIRECTORY);
    assert_eq!(result.truncated, 200);
}

#[tokio::test]
async fn a_junction_escaping_the_worktree_is_classified_cannot_access() {
    let session = format!("s-{}", uuid::Uuid::new_v4());
    let root = std::env::temp_dir().join(format!("refract-listdir-junc-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let outside =
        std::env::temp_dir().join(format!("refract-listdir-outside-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&outside).unwrap();
    let link = root.join("escape-link");
    make_junction(&outside, &link);
    if !link.exists() {
        return; // mklink refused outside CI; already asserted/logged inside make_junction
    }
    let result = list_directory_entries(&session, None, &root, "")
        .await
        .expect("listing should succeed even with an unresolvable link entry");
    let escape_entry = result
        .entries
        .iter()
        .find(|e| e.name == "escape-link")
        .expect("the junction entry itself must still be listed");
    assert_eq!(escape_entry.kind, FileTreeEntryKind::CannotAccess);
}

#[tokio::test]
async fn a_junction_staying_inside_the_worktree_is_classified_as_a_folder() {
    let session = format!("s-{}", uuid::Uuid::new_v4());
    let root =
        std::env::temp_dir().join(format!("refract-listdir-junc-in-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(root.join("real")).unwrap();
    let link = root.join("alias");
    make_junction(&root.join("real"), &link);
    if !link.exists() {
        return;
    }
    let result = list_directory_entries(&session, None, &root, "")
        .await
        .expect("listing should succeed");
    let alias_entry = result
        .entries
        .iter()
        .find(|e| e.name == "alias")
        .expect("the junction entry itself must still be listed");
    assert_eq!(alias_entry.kind, FileTreeEntryKind::Folder);
}
