// Test module for `remove_tree.rs`, split into its own file via `#[path = ...]` (same
// convention `git/worktree_delete.rs`/`worktree_delete_tests.rs` and `fs/resolve.rs`/
// `resolve_tests.rs` already use) to keep `remove_tree.rs` itself under the 600-line soft cap.
// Scratch dirs are left under the OS temp folder, never removed, matching this crate's other
// test modules.

use super::*;

fn is_ci() -> bool {
    std::env::var("CI").is_ok()
}

/// Directory junctions (`mklink /J`) need no elevation or Developer Mode on Windows, unlike file
/// symlinks -- so junction-based tests below never soft-skip under CI (same convention
/// `fs/resolve_tests.rs`'s own `make_junction` and `git/worktree_validity.rs` already use).
/// Panics in CI rather than silently skipping; soft-skips (with a message, zero assertions
/// proven) only outside CI, e.g. a sandboxed dev machine that refuses `mklink` outright.
fn make_junction(target_dir: &Path, link: &Path) -> bool {
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
    ok
}

/// A FILE symlink (as opposed to a directory junction) needs Developer Mode or elevation on
/// Windows (`mklink` with no `/J`/`/D`) -- soft-skips outside CI only, matching
/// `git/worktree_delete_tests.rs`'s own convention for its one file-symlink-shaped test.
fn make_file_symlink(target_file: &Path, link: &Path) -> bool {
    let status = std::process::Command::new("cmd")
        .args(["/C", "mklink"])
        .arg(link)
        .arg(target_file)
        .status();
    let ok = matches!(status, Ok(s) if s.success());
    if !ok {
        if is_ci() {
            panic!("file symlink creation failed in CI: mklink {link:?} {target_file:?}");
        }
        eprintln!("skipping file-symlink test: mklink refused (sandbox restriction, not CI)");
    }
    ok
}

async fn scratch_root(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("refract-remove-tree-{label}-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&dir).await.unwrap();
    dir
}

// --- Containment ---------------------------------------------------------------------------

#[tokio::test]
async fn refuses_the_boundary_root_itself() {
    let root = scratch_root("root-itself").await;
    let result = remove_tree(&root, &root).await;
    assert!(matches!(result, Err(RemoveTreeError::OutsideBoundary)));
    assert!(tokio::fs::metadata(&root).await.is_ok(), "the root must survive a refused call untouched");
}

#[tokio::test]
async fn refuses_a_path_outside_the_boundary_root() {
    let root = scratch_root("root").await;
    let sibling = scratch_root("sibling-not-nested").await;
    let marker = sibling.join("marker.txt");
    tokio::fs::write(&marker, b"do not touch").await.unwrap();

    let result = remove_tree(&sibling, &root).await;
    assert!(matches!(result, Err(RemoveTreeError::OutsideBoundary)));
    assert!(
        tokio::fs::metadata(&marker).await.is_ok(),
        "a path outside the boundary root must be refused outright, nothing touched"
    );
}

#[tokio::test]
async fn refuses_a_prefix_lookalike_sibling_of_the_boundary_root() {
    // `a-root-evil` shares a string prefix with `a-root` but is not nested inside it -- the
    // same lookalike-sibling class `git/worktree_delete_tests.rs`'s own
    // `assert_within_worktrees_root_treats_a_string_prefix_lookalike_sibling_as_outside` locks
    // in for `worktrees_root`; this proves `remove_tree`'s own containment check (a DIFFERENT
    // function, `canonical_comparable_path` plus a `starts_with` over a separator-joined
    // prefix) is not vulnerable to the same naive-prefix mistake.
    let root = scratch_root("a-root").await;
    let lookalike = root.with_file_name(format!("{}-evil", root.file_name().unwrap().to_string_lossy()));
    tokio::fs::create_dir_all(&lookalike).await.unwrap();
    let target = lookalike.join("session");
    tokio::fs::create_dir_all(&target).await.unwrap();

    let result = remove_tree(&target, &root).await;
    assert!(matches!(result, Err(RemoveTreeError::OutsideBoundary)));
    assert!(tokio::fs::metadata(&target).await.is_ok());
}

// --- Plain removal --------------------------------------------------------------------------

#[tokio::test]
async fn removes_a_plain_nested_tree() {
    let root = scratch_root("plain").await;
    let tree = root.join("session");
    tokio::fs::create_dir_all(tree.join("sub").join("deeper")).await.unwrap();
    tokio::fs::write(tree.join("file.txt"), b"hi").await.unwrap();
    tokio::fs::write(tree.join("sub").join("deeper").join("f2.txt"), b"hi").await.unwrap();

    let result = remove_tree(&tree, &root).await;
    assert!(result.is_ok(), "{result:?}");
    assert!(tokio::fs::metadata(&tree).await.is_err());
}

// --- Links: removed as links, never descended into -----------------------------------------

#[tokio::test]
async fn unlinks_a_junction_without_following_it() {
    let root = scratch_root("junction-owner").await;
    let tree = root.join("session");
    tokio::fs::create_dir_all(&tree).await.unwrap();

    let outside = scratch_root("junction-target").await;
    let marker = outside.join("marker.txt");
    tokio::fs::write(&marker, b"do not touch").await.unwrap();

    let link = tree.join("node_modules_link");
    if !make_junction(&outside, &link) {
        return;
    }

    let result = remove_tree(&tree, &root).await;
    assert!(result.is_ok(), "{result:?}");
    assert!(tokio::fs::metadata(&tree).await.is_err(), "the tree itself (and the link within it) must be gone");
    assert!(
        tokio::fs::metadata(&marker).await.is_ok(),
        "the junction's real target must survive untouched -- removing the link must never recurse into it"
    );
}

#[tokio::test]
async fn unlinks_a_file_symlink_without_following_it() {
    let root = scratch_root("symlink-owner").await;
    let tree = root.join("session");
    tokio::fs::create_dir_all(&tree).await.unwrap();

    let outside = scratch_root("symlink-target").await;
    let target_file = outside.join("secret.txt");
    tokio::fs::write(&target_file, b"do not touch").await.unwrap();

    let link = tree.join("alias.txt");
    if !make_file_symlink(&target_file, &link) {
        return;
    }

    let result = remove_tree(&tree, &root).await;
    assert!(result.is_ok(), "{result:?}");
    assert!(tokio::fs::metadata(&tree).await.is_err());
    assert!(
        tokio::fs::metadata(&target_file).await.is_ok(),
        "the symlink's real target file must survive untouched"
    );
}

/// "Re-check the reparse attribute right before each descent" (`remove_contents`'s own doc
/// comment): a junction planted several levels DEEP, not just at the tree's own top level, must
/// still be unlinked rather than descended into when the walk reaches it partway through.
#[tokio::test]
async fn unlinks_a_junction_nested_several_levels_deep() {
    let root = scratch_root("deep-junction-owner").await;
    let tree = root.join("session");
    tokio::fs::create_dir_all(tree.join("a").join("b").join("c")).await.unwrap();

    let outside = scratch_root("deep-junction-target").await;
    let marker = outside.join("marker.txt");
    tokio::fs::write(&marker, b"do not touch").await.unwrap();

    let link = tree.join("a").join("b").join("c").join("deep_link");
    if !make_junction(&outside, &link) {
        return;
    }

    let result = remove_tree(&tree, &root).await;
    assert!(result.is_ok(), "{result:?}");
    assert!(tokio::fs::metadata(&tree).await.is_err());
    assert!(tokio::fs::metadata(&marker).await.is_ok());
}

// --- Read-only files -------------------------------------------------------------------------

#[tokio::test]
async fn removes_a_read_only_file() {
    let root = scratch_root("readonly").await;
    let tree = root.join("session");
    tokio::fs::create_dir_all(&tree).await.unwrap();
    let file = tree.join("locked.txt");
    tokio::fs::write(&file, b"hi").await.unwrap();
    let mut perms = tokio::fs::metadata(&file).await.unwrap().permissions();
    #[allow(clippy::permissions_set_readonly_false)]
    perms.set_readonly(true);
    tokio::fs::set_permissions(&file, perms).await.unwrap();

    let result = remove_tree(&tree, &root).await;
    assert!(result.is_ok(), "{result:?} -- std::fs::remove_dir_all would have failed here without clearing read-only first");
    assert!(tokio::fs::metadata(&tree).await.is_err());
}

#[tokio::test]
async fn removes_a_read_only_directory() {
    let root = scratch_root("readonly-dir").await;
    let tree = root.join("session");
    let sub = tree.join("sub");
    tokio::fs::create_dir_all(&sub).await.unwrap();
    tokio::fs::write(sub.join("f.txt"), b"hi").await.unwrap();
    let mut perms = tokio::fs::metadata(&sub).await.unwrap().permissions();
    #[allow(clippy::permissions_set_readonly_false)]
    perms.set_readonly(true);
    tokio::fs::set_permissions(&sub, perms).await.unwrap();

    let result = remove_tree(&tree, &root).await;
    assert!(result.is_ok(), "{result:?}");
    assert!(tokio::fs::metadata(&tree).await.is_err());
}

// --- Long paths (`\\?\` verbatim) -------------------------------------------------------------

#[tokio::test]
async fn removes_a_tree_containing_a_path_over_260_characters() {
    let root = scratch_root("long-path").await;
    let tree = root.join("session");
    // Each component is short (well under any single-segment limit); nesting enough of them
    // pushes the FULL joined path past `LONG_PATH_THRESHOLD` (260), the same shape a real
    // `node_modules` tree's own deep dependency chains produce. Built via this crate's own
    // `long_path()` (brought in by `use super::*`) so SETUP, not just the removal this test
    // actually exercises, works past `MAX_PATH` too.
    let mut deep = tree.clone();
    for i in 0..40 {
        deep = deep.join(format!("segment-{i:03}-abcdefghij"));
    }
    tokio::fs::create_dir_all(long_path(&deep)).await.unwrap();
    let file = deep.join("f.txt");
    assert!(file.to_string_lossy().len() > LONG_PATH_THRESHOLD, "fixture must actually exceed the threshold this test is proving");
    tokio::fs::write(long_path(&file), b"hi").await.unwrap();

    let result = remove_tree(&tree, &root).await;
    assert!(result.is_ok(), "{result:?}");
    assert!(tokio::fs::metadata(long_path(&tree)).await.is_err());
}

#[test]
fn long_path_prefixes_a_path_over_the_threshold() {
    let short = Path::new(r"C:\short\path");
    assert_eq!(long_path(short), short);

    let long_str = format!(r"C:\{}", "a".repeat(300));
    let long = Path::new(&long_str);
    let prefixed = long_path(long);
    assert!(prefixed.to_string_lossy().starts_with(r"\\?\"));
}

#[test]
fn long_path_leaves_an_already_prefixed_path_alone() {
    let already = Path::new(r"\\?\C:\already\prefixed");
    assert_eq!(long_path(already), already);
}

// --- `is_directory_attribute` -----------------------------------------------------------------

#[tokio::test]
async fn is_directory_attribute_is_true_for_a_real_directory_and_false_for_a_file() {
    let root = scratch_root("attr").await;
    let dir = root.join("dir");
    tokio::fs::create_dir_all(&dir).await.unwrap();
    let file = root.join("file.txt");
    tokio::fs::write(&file, b"hi").await.unwrap();

    assert!(is_directory_attribute(&tokio::fs::metadata(&dir).await.unwrap()));
    assert!(!is_directory_attribute(&tokio::fs::metadata(&file).await.unwrap()));
}

/// The whole reason `remove_link` checks the raw `FILE_ATTRIBUTE_DIRECTORY` bit directly
/// instead of `Metadata::is_dir()`: `is_dir()` is always `false` for anything `is_symlink()`
/// reports `true` for, which is exactly wrong for a directory-type junction -- it still carries
/// the raw directory attribute bit even though `is_dir()` reports `false` for it.
#[tokio::test]
async fn is_directory_attribute_is_true_for_a_junction_even_though_is_dir_is_false() {
    let root = scratch_root("attr-junction").await;
    let target = scratch_root("attr-junction-target").await;
    let link = root.join("link");
    if !make_junction(&target, &link) {
        return;
    }
    let meta = tokio::fs::symlink_metadata(&link).await.unwrap();
    assert!(!meta.is_dir(), "sanity: std reports false for a junction's own is_dir()");
    assert!(is_directory_attribute(&meta), "the raw attribute bit must still say directory");
}
