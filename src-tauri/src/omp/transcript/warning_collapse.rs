// Repeated identical warnings share one transcript row that carries a `×N` count.

use std::sync::Arc;

use super::{NoticeLevel, TranscriptItem};

/// Splits a trailing ` ×N` repeat count off a warning's text.
fn split_repeat_count(text: &str) -> (&str, u64) {
    text.rsplit_once(" \u{d7}")
        .and_then(|(base, n)| Some((base, n.parse::<u64>().ok()?)))
        .unwrap_or((text, 1))
}

/// Warnings recur after every tool step, so an identical earlier warning anywhere in the log is
/// bumped to `text ×N` instead of adding another row; `None` when there is no earlier match.
pub(super) fn collapse_repeated_warning(
    items: &[Arc<TranscriptItem>],
    message: &str,
) -> Option<Vec<Arc<TranscriptItem>>> {
    let index = items.iter().rposition(|item| {
        matches!(&**item, TranscriptItem::Notice { level: NoticeLevel::Warning, text, .. }
            if split_repeat_count(text).0 == message)
    })?;
    let TranscriptItem::Notice { id, level, text } = &*items[index] else {
        return None;
    };
    let count = split_repeat_count(text).1 + 1;
    let mut merged = items.to_vec();
    merged[index] = Arc::new(TranscriptItem::Notice {
        id: id.clone(),
        level: *level,
        text: format!("{message} \u{d7}{count}"),
    });
    Some(merged)
}
