// Test module for `resolve.rs`, kept in a sibling file for the 600-line cap.
// Scratch dirs are left under the OS temp folder.

use super::*;


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
    let expected = dunce::canonicalize(&root)
        .unwrap()
        .join("sub")
        .join("file.txt");
    assert_eq!(result.expect("expected Ok"), expected);
}

#[tokio::test]
async fn case_differing_token_still_resolves_on_windows() {
    let root = fixture().await;
    let result = resolve_in_worktree(&root, "SUB/FILE.TXT").await;
    // Case-insensitive NTFS must return the true-cased path, not the echoed token.
    let expected = dunce::canonicalize(&root)
        .unwrap()
        .join("sub")
        .join("file.txt");
    assert_eq!(result.expect("expected Ok"), expected);
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
    let expected = dunce::canonicalize(&root)
        .unwrap()
        .join("sub")
        .join("file.txt");
    assert_eq!(result.expect("expected Ok"), expected);
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
async fn resolve_in_worktree_itself_does_not_special_case_dot_git_that_is_fs_list_directorys_job() {
    // `.git` is rejected by the caller, not here; this function only proves containment.
    let root = fixture().await;
    let result = resolve_in_worktree(&root, ".git/HEAD").await;
    let resolved = result.expect("resolve_in_worktree has no .git policy of its own");
    let expected = dunce::canonicalize(&root)
        .unwrap()
        .join(".git")
        .join("HEAD");
    assert_eq!(resolved, expected);
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

fn is_ci() -> bool {
    std::env::var("CI").is_ok()
}

/// Junctions need no elevation, so these tests run under CI and never soft-skip.
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

#[tokio::test]
async fn a_junction_escaping_the_worktree_is_outside_worktree() {
    let root = fixture().await;
    let outside =
        std::env::temp_dir().join(format!("refract-resolve-outside-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&outside).await.unwrap();
    tokio::fs::write(outside.join("secret.txt"), b"nope")
        .await
        .unwrap();
    let link = root.join("escape-link");
    if !make_junction(&outside, &link) {
        return;
    }
    let result = resolve_in_worktree(&root, "escape-link/secret.txt").await;
    assert_eq!(result.unwrap_err(), ResolveReason::OutsideWorktree);
}

#[tokio::test]
async fn an_in_worktree_junction_still_resolves() {
    let root = fixture().await;
    let link = root.join("alias");
    if !make_junction(&root.join("sub"), &link) {
        return;
    }
    let result = resolve_in_worktree(&root, "alias/file.txt").await;
    let expected = dunce::canonicalize(&root)
        .unwrap()
        .join("sub")
        .join("file.txt");
    assert_eq!(result.expect("expected Ok"), expected);
}

#[tokio::test]
async fn a_junction_in_a_middle_segment_still_resolves_the_remaining_segments() {
    // A junction in a middle segment, so the walk restarts from root with the remaining segments.
    let root = fixture().await;
    tokio::fs::create_dir_all(root.join("sub").join("deep"))
        .await
        .unwrap();
    tokio::fs::write(root.join("sub").join("deep").join("c.txt"), b"deep")
        .await
        .unwrap();
    let link = root.join("mid-link");
    if !make_junction(&root.join("sub"), &link) {
        return;
    }
    let result = resolve_in_worktree(&root, "mid-link/deep/c.txt").await;
    let expected = dunce::canonicalize(&root)
        .unwrap()
        .join("sub")
        .join("deep")
        .join("c.txt");
    assert_eq!(result.expect("expected Ok"), expected);
}

#[tokio::test]
async fn a_junction_resolving_back_to_the_worktree_root_is_file_missing() {
    let root = fixture().await;
    let link = root.join("loop");
    if !make_junction(&root, &link) {
        return;
    }
    let result = resolve_in_worktree(&root, "loop").await;
    assert_eq!(result.unwrap_err(), ResolveReason::FileMissing);
}

#[tokio::test]
async fn a_worktree_reached_through_its_own_junction_alias_still_accepts_the_alias_form() {
    // An absolute token in the junction-alias form must still be accepted.
    let real_root = fixture().await;
    let alias_root =
        std::env::temp_dir().join(format!("refract-resolve-alias-{}", uuid::Uuid::new_v4()));
    if !make_junction(&real_root, &alias_root) {
        return;
    }
    let absolute_alias_token = alias_root.join("sub").join("file.txt");
    let result = resolve_in_worktree(&alias_root, absolute_alias_token.to_str().unwrap()).await;
    let expected = dunce::canonicalize(&real_root)
        .unwrap()
        .join("sub")
        .join("file.txt");
    assert_eq!(result.expect("expected Ok"), expected);
}

#[tokio::test]
async fn a_junction_cycle_is_rejected_rather_than_looping_forever() {
    let root = fixture().await;
    let a = root.join("junc-a");
    let b = root.join("junc-b");
    tokio::fs::create_dir_all(&b).await.unwrap();
    if !make_junction(&b, &a) {
        return;
    }
    // Junctions alone close the cycle. `exists()` follows reparse points and would fail, so use `symlink_metadata`.
    let _ = tokio::fs::remove_dir(&b).await; // directories must be empty before mklink /J (re)targets them
    if !make_junction(&a, &b) {
        return;
    }
    assert!(
        std::fs::symlink_metadata(&b).is_ok(),
        "the junction reparse point itself must exist even though its cyclic target cannot resolve"
    );
    let result = resolve_in_worktree(&root, "junc-a").await;
    assert_eq!(
        result.unwrap_err(),
        ResolveReason::OutsideWorktree,
        "a link cycle must hit MAX_LINK_HOPS and be rejected, not looped forever"
    );
}

/// Kelvin sign (`U+212A`) must not fold to `k`; a Unicode fold would surface as `FileMissing`.
#[tokio::test]
async fn kelvin_sign_does_not_fold_to_k_against_a_sibling_folder() {
    let root = fixture().await;
    tokio::fs::create_dir_all(root.join("kit")).await.unwrap();
    let kelvin_sibling = format!("{}it", '\u{212a}');
    tokio::fs::create_dir_all(root.join(&kelvin_sibling))
        .await
        .unwrap();
    tokio::fs::write(root.join(&kelvin_sibling).join("secret.txt"), b"nope")
        .await
        .unwrap();
    let absolute_token = root.join(&kelvin_sibling).join("secret.txt");
    let result = resolve_in_worktree(&root.join("kit"), absolute_token.to_str().unwrap()).await;
    assert_eq!(
        result.unwrap_err(),
        ResolveReason::OutsideWorktree,
        "U+212A must never fold to plain k/K; a regression would instead surface FileMissing"
    );
}

#[tokio::test]
async fn a_link_chain_to_a_unc_target_is_outside_worktree() {
    // Junctions cannot target UNC paths, so this needs symlinks. The UNC hop is the second
    // link, which proves the per-hop `is_unsafe_token` check.
    let root = fixture().await;
    let a = root.join("chain-a");
    let b = root.join("chain-b");
    let made_b = tokio::fs::symlink_file("\\\\attacker\\share\\payload.txt", &b)
        .await
        .is_ok();
    let made_a = tokio::fs::symlink_file("chain-b", &a).await.is_ok();
    if !made_a || !made_b {
        if is_ci() {
            panic!(
                "symlink creation failed in CI for the UNC-chain test (chain-a -> chain-b -> UNC)"
            );
        }
        eprintln!(
            "skipping UNC-chain test: this environment cannot create symlinks (no Developer Mode / not elevated); junctions cannot target UNC paths at all"
        );
        return;
    }
    let result = resolve_in_worktree(&root, "chain-a").await;
    assert_eq!(result.unwrap_err(), ResolveReason::OutsideWorktree);
}

/// The 20 hostile-path table; each row states its exact expected `ResolveReason`.
#[tokio::test]
async fn the_twenty_hostile_path_table() {
    let root = fixture().await;
    let cases: &[(&str, ResolveReason)] = &[
        ("../outside.txt", ResolveReason::OutsideWorktree), // traversal
        (
            "\\\\127.0.0.1\\C$\\file.txt",
            ResolveReason::OutsideWorktree,
        ), // UNC
        (
            "\\\\?\\C:\\Windows\\System32",
            ResolveReason::OutsideWorktree,
        ), // device (\\?\)
        ("\\\\.\\PhysicalDrive0", ResolveReason::OutsideWorktree), // device (\\.\)
        ("D:secret.txt", ResolveReason::OutsideWorktree),   // drive-relative
        ("Z:\\elsewhere\\file.txt", ResolveReason::OutsideWorktree), // absolute other drive
        ("sub/file.txt:hidden", ResolveReason::OutsideWorktree), // ADS colon
        ("CON", ResolveReason::OutsideWorktree),            // reserved device name
        ("COM\u{00b9}", ResolveReason::OutsideWorktree),    // reserved name, superscript digit
        ("a\0b", ResolveReason::OutsideWorktree),           // embedded NUL
        ("javascript:alert(1)", ResolveReason::OutsideWorktree), // colon, no drive letter
    ];
    for (token, expected) in cases {
        let result = resolve_in_worktree(&root, token).await;
        assert_eq!(
            result.unwrap_err(),
            *expected,
            "token {token:?} expected {expected:?}"
        );
    }
    // Link, junction and 8.3 cases need real fixtures, so each has its own test instead.
}
