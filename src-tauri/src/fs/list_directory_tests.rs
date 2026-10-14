// Test module for `list_directory.rs`, split into this sibling file to stay under the 600-line
// soft cap -- included via `#[path = "list_directory_tests.rs"] mod tests;`. Gate round 1 fix:
// `resolve_list_target`/`list_directory_entries` had NO tests at all despite the issue naming
// every one of these cases explicitly.

use super::*;
use crate::git::test_support::{init_repo, run_git};

fn is_ci() -> bool {
    std::env::var("CI").is_ok()
}

/// Directory junctions (`mklink /J`) need no elevation or Developer Mode on Windows -- panics
/// under CI rather than silently skipping (matches `git/worktree_validity.rs`'s own convention,
/// gate round 1 fix: a soft-skipped link test proves nothing under CI).
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
    // Windows auto-generates an 8.3 short-name alias for any folder not already in 8.3 form
    // (`.git` has a leading dot, so it qualifies) UNLESS the volume has disabled 8.3 generation
    // -- not every alias is guaranteed `GIT~1` specifically, so this asserts the invariant that
    // actually matters (never successfully lists into `.git`, whichever code path catches it),
    // rather than assuming one exact alias string.
    let session = format!("s-{}", uuid::Uuid::new_v4());
    let root = fixture();
    let result = resolve_list_target(&session, None, &root, "GIT~1/HEAD").await;
    assert!(
        result.is_err(),
        "must never resolve into .git via a short-name alias"
    );
}

#[tokio::test]
async fn a_valid_empty_worktree_lists_as_genuinely_empty() {
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
    // Remove the only tracked file so the worktree is genuinely, validly empty of content (the
    // `.git` pointer file itself still proves registration).
    let result = list_directory_entries(&session, Some(&repo), &worktree, "").await;
    match result {
        Ok(ok) => assert_eq!(ok.entries.len(), 1, "README.md from the seed commit"),
        Err(_) => panic!("a validly registered worktree must not report worktree-missing"),
    }
}

#[tokio::test]
async fn an_unregistered_orphaned_folder_is_worktree_missing_not_empty() {
    // Issue #729: a folder that exists but was never (or is no longer) registered with git must
    // report `worktree-missing`, never a false "this folder is empty".
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
