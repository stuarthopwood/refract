//! The Session-directory filter (`Filters.session_dir`): a separator-bounded descendant match.
use rusqlite::types::Value;

use super::queries::{QueryError, QueryResult, Where};

/// Folds a Session directory like `normalise_path`, but ASCII-lowercase to agree with SQL `lower()`.
pub(super) fn normalise(raw: &str) -> QueryResult<String> {
    let trimmed = raw.trim();
    let bare = trimmed
        .strip_prefix(r"\\?\")
        .or_else(|| trimmed.strip_prefix("//?/"))
        .unwrap_or(trimmed);
    let folded = bare.replace('/', "\\").to_ascii_lowercase();
    let dir = folded.trim_end_matches('\\').to_string();
    if dir.is_empty() {
        return Err(QueryError::InvalidArgument("empty session directory".into()));
    }
    Ok(dir)
}

/// `column` at or below `dir`, never a bare `LIKE`: `C:\a\b` must not match `C:\a\bc\x.jsonl`.
pub(super) fn clause(w: &mut Where, dir: &str, column: &str) -> QueryResult<String> {
    let p = w.bind(Value::Text(normalise(dir)?));
    let file = format!("lower(replace({column}, '/', '\\'))");
    Ok(format!(
        "(substr({file}, 1, length({p})) = {p} AND substr({file}, length({p}) + 1, 1) = '\\')"
    ))
}
