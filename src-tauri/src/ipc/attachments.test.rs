// Unit tests for `ipc::attachments` (lane R4, issue #787; gate-fix round 1): the text-only
// `is_unsafe_token`/`is_reserved_name` rejections, the lexical/verbatim-prefix helpers, and the
// filesystem-backed `resolve_in_worktree`/`resolve_no_follow`/`resolve_no_follow_unrooted`/
// `read_image_file` paths, including a symlink that stays inside the worktree (accepted) and one
// that escapes it (rejected) -- the central security property this module exists for.
// `#[path]`-loaded sibling of `attachments.rs` (excluded from `check:file-size` by its own
// `.test.rs` name, matching the project's TS `*.test.ts` convention).

use super::*;
use uuid::Uuid;

// ---------------------------------------------------------------------------
// is_unsafe_token / is_reserved_name (text-only, no filesystem)
// ---------------------------------------------------------------------------

#[test]
fn is_unsafe_token_rejects_nul_byte() {
    assert!(is_unsafe_token("a\0b"));
}

#[test]
fn is_unsafe_token_rejects_unc_and_device_paths() {
    assert!(is_unsafe_token(r"\\host\share\file.png"));
    assert!(is_unsafe_token("//host/share/file.png"));
    assert!(is_unsafe_token(r"\\?\C:\file.png"));
    assert!(is_unsafe_token(r"\\.\C:\file.png"));
}

#[test]
fn is_unsafe_token_rejects_drive_relative_and_bare_drive() {
    assert!(is_unsafe_token("D:foo"));
    assert!(is_unsafe_token("D:"));
}

#[test]
fn is_unsafe_token_accepts_a_real_drive_absolute_path() {
    assert!(!is_unsafe_token(r"C:\Users\someone\file.png"));
}

#[test]
fn is_unsafe_token_rejects_alternate_data_stream_colon() {
    assert!(is_unsafe_token(r"C:\tmp\host.txt:hidden.png"));
}

#[test]
fn is_unsafe_token_rejects_any_other_colon() {
    assert!(is_unsafe_token("javascript:alert(1)"));
    assert!(is_unsafe_token("data:image/png;base64,AAAA"));
}

#[test]
fn is_unsafe_token_accepts_an_ordinary_relative_path() {
    assert!(!is_unsafe_token("images/test.png"));
    assert!(!is_unsafe_token("test.png"));
}

#[test]
fn is_reserved_name_matches_every_documented_shape() {
    assert!(is_reserved_name("CON"));
    assert!(is_reserved_name("con"));
    assert!(is_reserved_name("CON.txt"));
    assert!(is_reserved_name("CON "));
    assert!(is_reserved_name("NUL"));
    assert!(is_reserved_name("PRN"));
    assert!(is_reserved_name("AUX"));
    assert!(is_reserved_name("CONIN$"));
    assert!(is_reserved_name("CONOUT$"));
    assert!(is_reserved_name("COM1"));
    assert!(is_reserved_name("LPT9"));
    assert!(is_reserved_name("COM\u{b9}")); // super­script COM¹
    assert!(is_reserved_name("LPT\u{b2}")); // superscript LPT²
    assert!(is_reserved_name("com\u{b3}.log"));
}

#[test]
fn is_reserved_name_does_not_match_ordinary_names() {
    assert!(!is_reserved_name("console"));
    assert!(!is_reserved_name("commands"));
    assert!(!is_reserved_name("image.png"));
    assert!(!is_reserved_name("COM10")); // not a single reserved digit
    assert!(!is_reserved_name("COM"));
}

#[test]
fn is_unsafe_token_rejects_a_reserved_name_anywhere_in_the_path() {
    assert!(is_unsafe_token("images/CON/file.png"));
    assert!(is_unsafe_token("CON.png"));
}

// ---------------------------------------------------------------------------
// lexical_normalize / strip_verbatim_prefix / fold_case
// ---------------------------------------------------------------------------

#[test]
fn lexical_normalize_collapses_parent_and_current_dir_components() {
    let out = lexical_normalize(Path::new(r"C:\a\b\..\c\.\d"));
    assert_eq!(out, PathBuf::from(r"C:\a\c\d"));
}

#[test]
fn strip_verbatim_prefix_strips_both_forms_case_insensitively() {
    assert_eq!(
        strip_verbatim_prefix(PathBuf::from(r"\\?\C:\foo")),
        PathBuf::from(r"C:\foo")
    );
    assert_eq!(
        strip_verbatim_prefix(PathBuf::from(r"\\?\unc\host\share")),
        PathBuf::from(r"\\host\share")
    );
    assert_eq!(
        strip_verbatim_prefix(PathBuf::from(r"\\?\UNC\host\share")),
        PathBuf::from(r"\\host\share")
    );
}

#[test]
fn strip_verbatim_prefix_passes_through_an_ordinary_path() {
    let p = PathBuf::from(r"C:\foo\bar");
    assert_eq!(strip_verbatim_prefix(p.clone()), p);
}

#[test]
fn fold_case_folds_ascii_only() {
    let folded = fold_case("AbC");
    if cfg!(target_os = "windows") {
        assert_eq!(folded, "abc");
    } else {
        assert_eq!(folded, "AbC");
    }
}

// ---------------------------------------------------------------------------
// Filesystem-backed: resolve_in_worktree / resolve_no_follow / resolve_no_follow_unrooted /
// read_image_file, against real temp-dir fixtures (including symlinks).
// ---------------------------------------------------------------------------

/// A scratch worktree directory under the OS temp dir, uniquely named per test, removed on drop.
struct TempWorktree {
    root: PathBuf,
}

impl TempWorktree {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("refract-r4-attach-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create scratch worktree dir");
        Self { root }
    }

    fn path(&self) -> &Path {
        &self.root
    }

    fn write(&self, relative: &str, bytes: &[u8]) -> PathBuf {
        let p = self.root.join(relative);
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).expect("create scratch subdir");
        }
        std::fs::write(&p, bytes).expect("write scratch fixture file");
        p
    }
}

impl Drop for TempWorktree {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn fake_png_bytes() -> Vec<u8> {
    let mut bytes = vec![0x89u8, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    bytes.extend_from_slice(&[0, 0, 0, 13]);
    bytes.extend_from_slice(b"IHDR");
    bytes.extend_from_slice(&4u32.to_be_bytes());
    bytes.extend_from_slice(&3u32.to_be_bytes());
    bytes
}

#[tokio::test]
async fn resolve_in_worktree_accepts_a_real_relative_file() {
    let wt = TempWorktree::new();
    wt.write("inside.png", &fake_png_bytes());
    let resolved = resolve_in_worktree(wt.path().to_str().unwrap(), "inside.png").await;
    assert!(
        resolved.is_ok(),
        "expected Ok, got {:?}",
        resolved.err().map(|_| "Err")
    );
}

#[tokio::test]
async fn resolve_in_worktree_rejects_an_outside_worktree_token() {
    let wt = TempWorktree::new();
    let resolved = resolve_in_worktree(wt.path().to_str().unwrap(), "../../outside.png").await;
    assert!(matches!(resolved, Err(ResolveReason::OutsideWorktree)));
}

#[tokio::test]
async fn resolve_in_worktree_rejects_a_missing_file() {
    let wt = TempWorktree::new();
    let resolved = resolve_in_worktree(wt.path().to_str().unwrap(), "does-not-exist.png").await;
    assert!(matches!(resolved, Err(ResolveReason::FileMissing)));
}

#[tokio::test]
async fn resolve_in_worktree_rejects_a_missing_worktree_root() {
    let missing_root = std::env::temp_dir().join(format!("refract-r4-missing-{}", Uuid::new_v4()));
    let resolved = resolve_in_worktree(missing_root.to_str().unwrap(), "inside.png").await;
    assert!(matches!(resolved, Err(ResolveReason::WorktreeMissing)));
}

#[tokio::test]
async fn resolve_attachment_path_accepts_an_absolute_token() {
    let wt = TempWorktree::new();
    let abs = wt.write("abs.png", &fake_png_bytes());
    let resolved =
        resolve_attachment_path(wt.path().to_str().unwrap(), abs.to_str().unwrap()).await;
    assert!(resolved.is_some());
}

#[tokio::test]
async fn resolve_attachment_path_rejects_an_unsafe_absolute_token() {
    let wt = TempWorktree::new();
    let resolved =
        resolve_attachment_path(wt.path().to_str().unwrap(), r"\\evil\share\file.png").await;
    assert!(resolved.is_none());
}

/// Attempts to create a file symlink, returning `None` (soft-skip, not a failure) when the
/// environment lacks symlink privilege (Windows requires Developer Mode or an elevated process;
/// not guaranteed on every CI runner) -- the surrounding test then returns early, with a loud
/// `eprintln!` so a skipped run is visible, rather than failing the whole suite on an
/// environment property this lane's own code does not control.
fn try_symlink(original: &Path, link: &Path) -> bool {
    #[cfg(windows)]
    {
        std::os::windows::fs::symlink_file(original, link).is_ok()
    }
    #[cfg(not(windows))]
    {
        std::os::unix::fs::symlink(original, link).is_ok()
    }
}

#[tokio::test]
async fn symlink_inside_the_worktree_resolves_through_the_link() {
    let wt = TempWorktree::new();
    let target = wt.write("real.png", &fake_png_bytes());
    let link = wt.path().join("link.png");
    if !try_symlink(&target, &link) {
        eprintln!(
            "skipped: this environment cannot create symlinks (no Developer Mode / not elevated)"
        );
        return;
    }
    let resolved = resolve_in_worktree(wt.path().to_str().unwrap(), "link.png").await;
    assert!(
        resolved.is_ok(),
        "an in-worktree symlink target must resolve"
    );
}

#[tokio::test]
async fn symlink_escaping_the_worktree_is_rejected() {
    let wt = TempWorktree::new();
    let outside_dir = std::env::temp_dir().join(format!("refract-r4-outside-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&outside_dir).expect("create outside dir");
    let outside_target = outside_dir.join("secret.png");
    std::fs::write(&outside_target, fake_png_bytes()).expect("write outside file");
    let link = wt.path().join("escape.png");
    if !try_symlink(&outside_target, &link) {
        eprintln!(
            "skipped: this environment cannot create symlinks (no Developer Mode / not elevated)"
        );
        let _ = std::fs::remove_dir_all(&outside_dir);
        return;
    }
    let resolved = resolve_in_worktree(wt.path().to_str().unwrap(), "escape.png").await;
    assert!(
        matches!(resolved, Err(ResolveReason::OutsideWorktree)),
        "a symlink pointing outside the worktree must never be followed: got {:?}",
        resolved.err().map(|_| "Err")
    );
    let _ = std::fs::remove_dir_all(&outside_dir);
}

#[tokio::test]
async fn resolve_no_follow_rejects_a_link_cycle() {
    let wt = TempWorktree::new();
    let a = wt.path().join("a.png");
    let b = wt.path().join("b.png");
    // a -> b, b -> a: neither ever resolves to a real file.
    if !try_symlink(&b, &a) {
        eprintln!(
            "skipped: this environment cannot create symlinks (no Developer Mode / not elevated)"
        );
        return;
    }
    if !try_symlink(&a, &b) {
        eprintln!(
            "skipped: this environment cannot create symlinks (no Developer Mode / not elevated)"
        );
        return;
    }
    let resolved = resolve_in_worktree(wt.path().to_str().unwrap(), "a.png").await;
    assert!(
        matches!(
            resolved,
            Err(ResolveReason::OutsideWorktree) | Err(ResolveReason::FileMissing)
        ),
        "a link cycle must be rejected, never hang or succeed"
    );
}

#[tokio::test]
async fn read_image_file_returns_valid_bytes_for_a_real_in_worktree_image() {
    let wt = TempWorktree::new();
    wt.write("photo.png", &fake_png_bytes());
    let result = read_image_file(wt.path().to_str().unwrap(), "photo.png").await;
    let value = result.expect("a real in-worktree PNG must be readable");
    assert_eq!(
        value.get("mimeType").and_then(Value::as_str),
        Some("image/png")
    );
    assert_eq!(
        value.get("byteLength").and_then(Value::as_u64),
        Some(fake_png_bytes().len() as u64)
    );
}

#[tokio::test]
async fn read_image_file_rejects_an_oversized_declared_pixel_count() {
    // Regression test for the gate-round-1 live finding: a tiny file can still declare an
    // enormous pixel count in its header (#771); the file-path reader must enforce the pixel
    // cap exactly like the base64 path does.
    let wt = TempWorktree::new();
    let mut bytes = vec![0x89u8, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    bytes.extend_from_slice(&[0, 0, 0, 13]);
    bytes.extend_from_slice(b"IHDR");
    bytes.extend_from_slice(&20000u32.to_be_bytes());
    bytes.extend_from_slice(&20000u32.to_be_bytes()); // 400,000,000 px, far over the 40 MP cap
    wt.write("bomb.png", &bytes);
    let result = read_image_file(wt.path().to_str().unwrap(), "bomb.png").await;
    let err = result.expect_err("an over-cap pixel count must be refused");
    assert_eq!(err.code, "image-too-large");
}

#[tokio::test]
async fn read_image_file_rejects_a_non_image_file() {
    let wt = TempWorktree::new();
    wt.write("notes.txt", b"just some plain text");
    let result = read_image_file(wt.path().to_str().unwrap(), "notes.txt").await;
    let err = result.expect_err("a non-image file must be refused");
    assert_eq!(err.code, "unsupported-image-type");
}

#[tokio::test]
async fn read_image_file_rejects_a_missing_file() {
    let wt = TempWorktree::new();
    let result = read_image_file(wt.path().to_str().unwrap(), "missing.png").await;
    let err = result.expect_err("a missing file must be refused");
    assert_eq!(err.code, "not-found");
}
