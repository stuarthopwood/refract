// Sorts a failed tool result into a coarse category from its text. Only the category is stored:
// the text itself never reaches `usage.db` (counts only).

/// Stored in `tool_calls.error_category` and sent to the renderer as `as_str()`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCategory {
    /// The tool was refused by a tool policy.
    Policy,
    /// An edit was rejected: stale anchors, a malformed payload or a hunk with no header.
    EditRejected,
    Timeout,
    /// The call was aborted or cancelled before it finished.
    Aborted,
    /// A path, file or directory the call named is missing.
    NotFound,
    /// The arguments failed validation.
    InvalidInput,
    /// An error with text that matches no other category.
    Other,
    /// An error recorded before categories existed: its text was never kept, so it cannot be sorted.
    Unknown,
}

impl ErrorCategory {
    /// Display order of the categories that can be assigned from text; `Unknown` is last.
    pub const ALL: [Self; 8] = [
        Self::Policy,
        Self::EditRejected,
        Self::InvalidInput,
        Self::NotFound,
        Self::Timeout,
        Self::Aborted,
        Self::Other,
        Self::Unknown,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Policy => "policy",
            Self::EditRejected => "edit_rejected",
            Self::Timeout => "timeout",
            Self::Aborted => "aborted",
            Self::NotFound => "not_found",
            Self::InvalidInput => "invalid_input",
            Self::Other => "other",
            Self::Unknown => "unknown",
        }
    }
}

/// An error message states its cause up front; scanning further only costs time on huge outputs.
const MAX_SCAN_CHARS: usize = 2_000;

/// First match wins, so a message that fits two rules lands in the more specific, earlier one.
const RULES: [(ErrorCategory, &[&str]); 6] = [
    (ErrorCategory::Policy, &["blocked by tool policy"]),
    (
        ErrorCategory::EditRejected,
        &[
            "edit rejected",
            "this edit anchors",
            "no preceding hunk header",
        ],
    ),
    (ErrorCategory::Timeout, &["timed out", "timeout"]),
    (
        ErrorCategory::Aborted,
        &["aborted", "cancelled", "canceled"],
    ),
    (
        ErrorCategory::NotFound,
        &["not found", "no such file", "does not exist", "enoent"],
    ),
    (
        ErrorCategory::InvalidInput,
        &["validation failed", "invalid ", "missing required"],
    ),
];

/// Categorises the text parts of a result whose `isError` is set. Only the first `MAX_SCAN_CHARS`
/// characters are read, lazily across the parts (a newline ends each), so a huge result is never
/// joined or copied whole. Never returns `Unknown`.
pub fn classify<'a>(parts: impl IntoIterator<Item = &'a str>) -> ErrorCategory {
    let head: String = parts
        .into_iter()
        .flat_map(|part| part.chars().chain(std::iter::once('\n')))
        .take(MAX_SCAN_CHARS)
        .collect::<String>()
        .to_lowercase();
    RULES
        .iter()
        .find(|(_, needles)| needles.iter().any(|n| head.contains(n)))
        .map_or(ErrorCategory::Other, |(category, _)| *category)
}

#[cfg(test)]
#[path = "error_category.test.rs"]
mod tests;
