// Port of `src/main/fs/paths.ts`: shared, dependency-free path predicates for the File explorer's
// worktree-containment logic (lane R7, issue #790). Zero dependencies of its own, same as the TS
// original, so `git::status` can use it without pulling in anything IPC-shaped.

/// Any path segment equal to `.git`, ASCII case-insensitively -- shared by every caller that
/// needs to reject `.git` itself as a path, a listing entry, or a status-map key (FR-007):
/// `fs::resolve`'s `resolve_in_worktree`/`fs::list_directory`'s `classify_symlink_entry` (via
/// `ipc::file_explorer`), and `git::status`'s own `.git`-as-a-status-key filter.
pub fn contains_git_segment(value: &str) -> bool {
    value
        .split(['\\', '/'])
        .any(|segment| segment.eq_ignore_ascii_case(".git"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_dot_git_segment_matches() {
        assert!(contains_git_segment(".git"));
    }

    #[test]
    fn mixed_case_dot_git_segment_matches() {
        assert!(contains_git_segment(".GiT"));
    }

    #[test]
    fn nested_dot_git_segment_matches_either_separator() {
        assert!(contains_git_segment("sub/.git"));
        assert!(contains_git_segment("sub\\.git\\hooks"));
    }

    #[test]
    fn a_segment_that_merely_contains_git_does_not_match() {
        assert!(!contains_git_segment("gitignore"));
        assert!(!contains_git_segment("sub/notgit"));
    }

    #[test]
    fn empty_string_does_not_match() {
        assert!(!contains_git_segment(""));
    }
}
