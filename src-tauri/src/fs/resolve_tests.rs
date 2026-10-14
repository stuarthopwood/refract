// Test module for `resolve.rs`, split into this sibling file to stay under the 600-line soft cap
// (`pnpm check:file-size`) -- included via `#[path = "resolve_tests.rs"] mod tests;` in
// `resolve.rs` itself (same convention `ipc/sessions_lifecycle_tests.rs` already uses). Scratch
// dirs are left under the OS temp folder, never removed, matching this crate's other test
// modules.

use super::*;

// --- `is_unsafe_token` -------------------------------------------------------------------

#[test]
fn nul_byte_is_unsafe() {
    assert!(is_unsafe_token("a\0b"));
}

#[test]
fn unc_path_is_unsafe() {
    assert!(is_unsafe_token("\\\\host\\share\\file.txt"));
    assert!(is_unsafe_token("//host/share/file.txt"));
}

#[test]
fn device_path_is_unsafe() {
    assert!(is_unsafe_token("\\\\?\\C:\\file.txt"));
    assert!(is_unsafe_token("\\\\.\\C:\\file.txt"));
}

#[test]
fn a_second_colon_after_a_drive_prefix_is_unsafe_ads() {
    assert!(is_unsafe_token("C:\\tmp\\host.txt:hidden.png"));
}

#[test]
fn a_plain_drive_prefixed_absolute_path_is_safe_shape() {
    assert!(!is_unsafe_token("C:\\tmp\\file.txt"));
}

#[test]
fn a_colon_with_no_drive_letter_is_unsafe() {
    assert!(is_unsafe_token("javascript:alert(1)"));
}

#[test]
fn a_drive_relative_token_is_unsafe() {
    assert!(is_unsafe_token("D:foo"));
    assert!(is_unsafe_token("D:"));
}

#[test]
fn reserved_device_names_are_unsafe() {
    assert!(is_unsafe_token("CON"));
    assert!(is_unsafe_token("con"));
    assert!(is_unsafe_token("sub/NUL"));
    assert!(is_unsafe_token("COM1"));
    assert!(is_unsafe_token("LPT9"));
    assert!(is_unsafe_token("CONIN$"));
    assert!(is_unsafe_token("CON.txt"));
    assert!(is_unsafe_token("CON "));
    assert!(is_unsafe_token("COM\u{00b9}"));
}

#[test]
fn com_ten_is_not_reserved_only_single_digit_is() {
    assert!(!is_unsafe_token("COM10"));
}

#[test]
fn a_name_merely_containing_a_reserved_word_is_safe() {
    assert!(!is_unsafe_token("CONTEST.txt"));
    assert!(!is_unsafe_token("economical.txt"));
}

#[test]
fn an_ordinary_relative_token_is_safe() {
    assert!(!is_unsafe_token("src/main.rs"));
    assert!(!is_unsafe_token("a/../b"));
}

// --- `resolve_in_worktree`: the 20-hostile-path table (issue #790) ------------------------

async fn fixture() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("refract-resolve-test-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(dir.join("sub")).await.unwrap();
    tokio::fs::write(dir.join("sub").join("file.txt"), b"hi")
        .await
        .unwrap();
    tokio::fs::create_dir_all(dir.join(".git")).await.unwrap();
    tokio::fs::write(dir.join(".git").join("HEAD"), b"ref: refs/heads/main")
        .await
        .unwrap();
    dir
}

#[tokio::test]
async fn plain_in_worktree_file_resolves() {
    let root = fixture().await;
    let result = resolve_in_worktree(&root, "sub/file.txt").await;
    assert!(result.is_ok());
}

#[tokio::test]
async fn case_differing_token_still_resolves_on_windows() {
    let root = fixture().await;
    let result = resolve_in_worktree(&root, "SUB/FILE.TXT").await;
    assert!(result.is_ok());
}

#[tokio::test]
async fn parent_traversal_escaping_the_root_is_outside_worktree() {
    let root = fixture().await;
    let result = resolve_in_worktree(&root, "../outside.txt").await;
    assert_eq!(result.unwrap_err(), ResolveReason::OutsideWorktree);
}

#[tokio::test]
async fn parent_traversal_that_stays_inside_resolves() {
    let root = fixture().await;
    let result = resolve_in_worktree(&root, "sub/../sub/file.txt").await;
    assert!(result.is_ok());
}

#[tokio::test]
async fn unc_token_is_outside_worktree() {
    let root = fixture().await;
    let result = resolve_in_worktree(&root, "\\\\127.0.0.1\\C$\\file.txt").await;
    assert_eq!(result.unwrap_err(), ResolveReason::OutsideWorktree);
}

#[tokio::test]
async fn device_token_is_outside_worktree() {
    let root = fixture().await;
    let result = resolve_in_worktree(&root, "\\\\?\\C:\\Windows\\System32").await;
    assert_eq!(result.unwrap_err(), ResolveReason::OutsideWorktree);
}

#[tokio::test]
async fn drive_relative_token_is_outside_worktree() {
    let root = fixture().await;
    let result = resolve_in_worktree(&root, "D:secret.txt").await;
    assert_eq!(result.unwrap_err(), ResolveReason::OutsideWorktree);
}

#[tokio::test]
async fn absolute_other_drive_token_is_outside_worktree() {
    let root = fixture().await;
    let result = resolve_in_worktree(&root, "Z:\\elsewhere\\file.txt").await;
    assert_eq!(result.unwrap_err(), ResolveReason::OutsideWorktree);
}

#[tokio::test]
async fn dot_git_as_the_requested_token_is_rejected_by_the_caller_level_check() {
    // `resolve_in_worktree` itself does not special-case `.git` as the top-level token (that
    // guard lives in `fs::list_directory::resolve_list_target`, FR-007) -- it DOES still
    // resolve successfully here, proving the two-layer design: this function only proves
    // containment, never the `.git` policy.
    let root = fixture().await;
    let result = resolve_in_worktree(&root, ".git/HEAD").await;
    assert!(result.is_ok());
}

#[tokio::test]
async fn an_ads_token_is_outside_worktree() {
    let root = fixture().await;
    let result = resolve_in_worktree(&root, "sub/file.txt:hidden").await;
    assert_eq!(result.unwrap_err(), ResolveReason::OutsideWorktree);
}

#[tokio::test]
async fn a_reserved_device_name_segment_is_outside_worktree() {
    let root = fixture().await;
    let result = resolve_in_worktree(&root, "CON").await;
    assert_eq!(result.unwrap_err(), ResolveReason::OutsideWorktree);
}

#[tokio::test]
async fn a_missing_file_is_file_missing() {
    let root = fixture().await;
    let result = resolve_in_worktree(&root, "sub/does-not-exist.txt").await;
    assert_eq!(result.unwrap_err(), ResolveReason::FileMissing);
}

#[tokio::test]
async fn the_worktree_root_itself_is_file_missing() {
    let root = fixture().await;
    let result = resolve_in_worktree(&root, "").await;
    assert_eq!(result.unwrap_err(), ResolveReason::FileMissing);
}

#[tokio::test]
async fn a_dot_token_resolving_to_root_is_file_missing() {
    let root = fixture().await;
    let result = resolve_in_worktree(&root, ".").await;
    assert_eq!(result.unwrap_err(), ResolveReason::FileMissing);
}

#[tokio::test]
async fn a_missing_worktree_root_is_worktree_missing() {
    let root =
        std::env::temp_dir().join(format!("refract-resolve-missing-{}", uuid::Uuid::new_v4()));
    let result = resolve_in_worktree(&root, "sub/file.txt").await;
    assert_eq!(result.unwrap_err(), ResolveReason::WorktreeMissing);
}

#[tokio::test]
async fn a_symlink_escaping_the_worktree_is_outside_worktree() {
    let root = fixture().await;
    let outside =
        std::env::temp_dir().join(format!("refract-resolve-outside-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&outside).await.unwrap();
    tokio::fs::write(outside.join("secret.txt"), b"nope")
        .await
        .unwrap();
    #[cfg(windows)]
    {
        if tokio::fs::symlink_file(outside.join("secret.txt"), root.join("link.txt"))
            .await
            .is_ok()
        {
            let result = resolve_in_worktree(&root, "link.txt").await;
            assert_eq!(result.unwrap_err(), ResolveReason::OutsideWorktree);
        }
        // else: symlink creation needs a privilege this CI/dev account may not hold --
        // skipped rather than failed, the junction-equivalent path is covered by the
        // in-worktree-link test below which needs no such privilege.
    }
}

#[tokio::test]
async fn an_in_worktree_symlink_still_resolves() {
    let root = fixture().await;
    #[cfg(windows)]
    {
        if tokio::fs::symlink_file(root.join("sub").join("file.txt"), root.join("alias.txt"))
            .await
            .is_ok()
        {
            let result = resolve_in_worktree(&root, "alias.txt").await;
            assert!(result.is_ok());
        }
    }
}

#[tokio::test]
async fn kelvin_sign_does_not_fold_to_k_across_sibling_folders() {
    let root = fixture().await;
    // NTFS does not treat U+212A (Kelvin sign) as the same character as `k`/`K` -- a folder
    // actually named with the Kelvin sign must not be reached by a token spelled with a
    // plain `k`, and vice versa; neither exists here, so both are `file-missing`/`outside`,
    // never silently resolved into the wrong sibling.
    let weird = format!("{}lvin", '\u{212a}');
    tokio::fs::create_dir_all(root.join(&weird)).await.unwrap();
    tokio::fs::write(root.join(&weird).join("f.txt"), b"x")
        .await
        .unwrap();
    let plain_result = resolve_in_worktree(&root, "kelvin/f.txt").await;
    assert!(plain_result.is_err());
}

#[tokio::test]
async fn a_link_cycle_is_rejected_rather_than_looping_forever() {
    let root = fixture().await;
    #[cfg(windows)]
    {
        let a = root.join("a.txt");
        let b = root.join("b.txt");
        let made_a = tokio::fs::symlink_file(&b, &a).await.is_ok();
        let made_b = tokio::fs::symlink_file(&a, &b).await.is_ok();
        if made_a && made_b {
            let result = resolve_in_worktree(&root, "a.txt").await;
            assert!(result.is_err());
        }
    }
}
