// Dependency-free so `git::status` can use it without pulling in IPC types.

/// True when any path segment is `.git`, ASCII case-insensitively.
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
