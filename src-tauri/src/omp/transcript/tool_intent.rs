//! A tool call's model-written intent (issue #469, `docs/spike/FINDINGS.md` item 64): OMP lifts
//! it to the top-level `intent` field of a live `tool_execution_start` frame and keeps it as
//! `arguments.i` on a history or snapshot `toolCall` part. The text is untrusted model output, so
//! it is cleaned here once, at the IPC boundary, and the renderer shows it as plain text.

use serde_json::Value;

/// Same cap as the session readout's `bounded()` (`session/readout_activity.rs`).
const MAX_INTENT_CHARS: usize = 400;

/// Live `tool_execution_start` frame: `intent`, then `args.i`, then `args.intent`.
pub(super) fn read_live_intent(frame: &Value) -> Option<String> {
    let args = frame.get("args");
    [
        frame.get("intent"),
        args.and_then(|a| a.get("i")),
        args.and_then(|a| a.get("intent")),
    ]
    .into_iter()
    .flatten()
    .filter_map(Value::as_str)
    .find_map(sanitize_intent)
}

/// History or snapshot `toolCall` part's `arguments`: `i`, then `intent`.
pub(super) fn read_history_intent(arguments: &Value) -> Option<String> {
    ["i", "intent"]
        .iter()
        .filter_map(|key| arguments.get(*key).and_then(Value::as_str))
        .find_map(sanitize_intent)
}

fn is_stripped(c: char) -> bool {
    c.is_control()
        || matches!(
            c,
            '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}'
        )
}

/// Drops C0/C1 controls and bidirectional formatting characters, collapses whitespace runs to
/// one space, trims, and caps at 400 characters; `None` when nothing is left.
pub(super) fn sanitize_intent(raw: &str) -> Option<String> {
    let mut out = String::new();
    let mut count = 0;
    let mut pending_space = false;
    for c in raw.chars() {
        // Whitespace controls (tab, newline) collapse like spaces rather than vanish.
        if c.is_whitespace() {
            pending_space = !out.is_empty();
            continue;
        }
        if is_stripped(c) {
            continue;
        }
        if pending_space {
            if count + 1 >= MAX_INTENT_CHARS {
                break;
            }
            out.push(' ');
            count += 1;
            pending_space = false;
        }
        if count >= MAX_INTENT_CHARS {
            break;
        }
        out.push(c);
        count += 1;
    }
    (!out.is_empty()).then_some(out)
}
