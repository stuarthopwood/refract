// Project label matching.

use std::path::Path;

use super::*;

fn index() -> ProjectIndex {
    ProjectIndex::from_pairs([
        ("C:\\Work\\proj", "proj"),
        ("C:\\Work\\proj\\.worktrees\\feature", "proj"),
        ("D:/Other/App/", "app"),
    ])
}

#[test]
fn matches_a_project_its_worktree_and_subfolders_ignoring_case_and_slashes() {
    let idx = index();
    assert_eq!(idx.match_cwd("c:/work/PROJ"), Some("proj"));
    assert_eq!(idx.match_cwd("C:\\Work\\proj\\src\\deep"), Some("proj"));
    assert_eq!(
        idx.match_cwd("C:\\Work\\proj\\.worktrees\\feature\\x"),
        Some("proj")
    );
    assert_eq!(idx.match_cwd("\\\\?\\D:\\Other\\App"), Some("app"));
}

#[test]
fn a_sibling_folder_sharing_a_name_prefix_does_not_match() {
    assert_eq!(index().match_cwd("C:\\Work\\proj-two"), None);
}

#[test]
fn label_falls_back_to_the_cwd_then_to_the_session_folder() {
    let idx = index();
    let root = Path::new("C:\\sessions");
    let file = Path::new("C:\\sessions\\enc-folder\\a.jsonl");
    assert_eq!(
        idx.label(Some("C:\\Elsewhere"), file, root),
        "C:\\Elsewhere"
    );
    assert_eq!(idx.label(None, file, root), "enc-folder");
    assert_eq!(idx.label(Some("  "), file, root), "enc-folder");
}
