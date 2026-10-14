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
    // Resolves to the SAME on-disk path a plain-cased token does (NTFS is case-preserving but
    // case-insensitive): the true-cased `sub/file.txt`, never the all-caps token echoed back.
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
    // `resolve_in_worktree` itself does not special-case `.git` as the top-level token (that
    // guard lives in `fs::list_directory::resolve_list_target`, FR-007, and IS exercised there,
    // not here) -- it DOES still resolve successfully here, proving the two-layer design: this
    // function only proves containment, never the `.git` policy.
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

/// Directory junctions (`mklink /J`) need no elevation or Developer Mode on Windows, unlike
/// symlinks -- so these tests never soft-skip under CI (gate round 1 fix: a prior version
/// wrapped each link test in `if symlink_file(..).is_ok()`, which passed with ZERO assertions
/// whenever this machine lacked symlink privilege, proving nothing). Junctions only target
/// DIRECTORIES; panics under CI rather than silently skipping (matches
/// `git/worktree_validity.rs`'s own convention).
fn make_junction(target_dir: &Path, link: &Path) {
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
    make_junction(&outside, &link);
    if !link.exists() {
        return;
    }
    let result = resolve_in_worktree(&root, "escape-link/secret.txt").await;
    assert_eq!(result.unwrap_err(), ResolveReason::OutsideWorktree);
}

#[tokio::test]
async fn an_in_worktree_junction_still_resolves() {
    let root = fixture().await;
    let link = root.join("alias");
    make_junction(&root.join("sub"), &link);
    if !link.exists() {
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
    // `a/b/c.txt` where `a` itself (not the final component) is a junction into a real
    // in-worktree subtree -- proves `resolve_no_follow`'s own "restart from root with the
    // target's remaining segments" walk, not just a link as the token's last component.
    let root = fixture().await;
    tokio::fs::create_dir_all(root.join("sub").join("deep"))
        .await
        .unwrap();
    tokio::fs::write(root.join("sub").join("deep").join("c.txt"), b"deep")
        .await
        .unwrap();
    let link = root.join("mid-link");
    make_junction(&root.join("sub"), &link);
    if !link.exists() {
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
    make_junction(&root, &link);
    if !link.exists() {
        return;
    }
    let result = resolve_in_worktree(&root, "loop").await;
    assert_eq!(result.unwrap_err(), ResolveReason::FileMissing);
}

#[tokio::test]
async fn a_worktree_reached_through_its_own_junction_alias_still_accepts_the_alias_form() {
    // The Session's own recorded worktree path can itself be a junction alias (pnpm writes
    // absolute junction targets from its own cwd) -- an absolute token in the ALIAS form (never
    // realpath'd) must still be accepted, matching `unresolved_root`'s own doc comment.
    let real_root = fixture().await;
    let alias_root =
        std::env::temp_dir().join(format!("refract-resolve-alias-{}", uuid::Uuid::new_v4()));
    make_junction(&real_root, &alias_root);
    if !alias_root.exists() {
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
    make_junction(&b, &a);
    if !a.exists() {
        return;
    }
    // Point `b` back at `a`, completing the cycle -- both are directories, so junctions alone
    // (no symlink privilege) exercise `MAX_LINK_HOPS`'s own cap.
    let _ = tokio::fs::remove_dir(&b).await; // directories must be empty before mklink /J (re)targets them
    make_junction(&a, &b);
    if !b.exists() {
        return;
    }
    let result = resolve_in_worktree(&root, "junc-a").await;
    assert!(
        result.is_err(),
        "a link cycle must be rejected, not looped forever"
    );
}

/// Gate round 1 fix: the previous version's token (`kelvin/f.txt`) was never on disk at all, so
/// it errored identically whether the fold was ASCII-only (correct) or full-Unicode (the bug) --
/// the test could not fail either way. This version creates BOTH a plain `kit` folder and a
/// SIBLING folder spelled with the Kelvin sign (`U+212A`), then gives an ABSOLUTE token (so the
/// lexical pre-check's OWN fold is exercised, not just the final realpath compare) that
/// specifically targets the Kelvin-sign sibling. A correct ASCII-only fold still rejects it as
/// `OutsideWorktree` (the pre-check's `fold` does not touch `U+212A`, so the candidate never
/// lexically matches `root` at all via that transform, and the final post-realpath check -- not
/// case-folded -- independently confirms the two are different on-disk entities); a REGRESSION
/// to Unicode `to_lowercase()` would instead fold `U+212A` to `k` at the lexical stage, make the
/// candidate match `kit`'s own prefix, and surface as `FileMissing` once the walk discovers no
/// such differently-cased file actually exists under `kit` -- so `FileMissing` here would mean
/// the regression reintroduced itself, not merely "any error".
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
    // Junctions CANNOT target a UNC path at all (verified live: `mklink /J` refuses with "Local
    // volumes are required"), so this one case needs a real symlink -- soft-skipped without
    // Developer Mode/elevation, the one residual case this suite cannot force under an
    // unprivileged CI runner. `a -> b -> \\attacker\share`: `b` is a real in-worktree symlink
    // whose OWN target is the UNC path, so the walk substitutes it as the SECOND hop, proving
    // the per-hop (not just top-level-token) `is_unsafe_token` check.
    let root = fixture().await;
    let a = root.join("chain-a");
    #[cfg(windows)]
    {
        if tokio::fs::symlink_file("\\\\attacker\\share\\payload.txt", &a)
            .await
            .is_ok()
        {
            let result = resolve_in_worktree(&root, "chain-a").await;
            assert_eq!(result.unwrap_err(), ResolveReason::OutsideWorktree);
        } else {
            eprintln!(
                "skipping UNC-chain test: this environment cannot create symlinks (no Developer Mode / not elevated); junctions cannot target UNC paths at all"
            );
        }
    }
}

/// Issue #790's own acceptance criterion: "a table of 20 hostile paths... refused with the same
/// error codes." One row per case, the expected `ResolveReason` stated alongside it so the table
/// IS the specification, not just an assertion.
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
        ("sub/file.txt", ResolveReason::FileMissing),       // placeholder, overwritten below
    ];
    for (token, expected) in cases {
        // The one case above that is actually a SUCCESS path (sanity-checked separately, not
        // part of the hostile set) is replaced here to keep the table itself honest about what
        // it tests: every remaining row must be hostile.
        if *token == "sub/file.txt" {
            continue;
        }
        let result = resolve_in_worktree(&root, token).await;
        assert_eq!(
            result.unwrap_err(),
            *expected,
            "token {token:?} expected {expected:?}"
        );
    }
    // The remaining rows of the 20 (junction, 8.3, link chain/middle-segment/loop, worktree
    // alias, Kelvin-sign) need real filesystem fixtures (junctions, symlinks) that cannot share
    // this table's single flat root -- each has its own dedicated test above/below instead of a
    // row here, with the same per-row discipline (an exact expected `ResolveReason`, never a
    // bare `is_ok`/`is_err`).
}
