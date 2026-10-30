// Strips credential-shaped substrings from diagnostic text before it reaches the renderer or a log.
// Pattern order matters: URL userinfo runs before email, and the BEGIN key pattern before its END fallback.
// Word boundaries are ASCII-only, because `fancy_regex` `\b` is Unicode-aware.

use std::sync::LazyLock;

use fancy_regex::Regex;

/// ASCII-only word boundary, since `fancy_regex` has no inline Unicode-mode toggle.
const ASCII_WORD_BOUNDARY: &str =
    r"(?:(?<![A-Za-z0-9_])(?=[A-Za-z0-9_])|(?<=[A-Za-z0-9_])(?![A-Za-z0-9_]))";

/// Every pattern/replacement pair, applied in order by `redact_secrets`.
static PATTERNS: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
    vec![
        // Bearer tokens. No trailing boundary: keys such as `sk-ant-...` contain hyphens.
        (
            Regex::new(&format!(
                "(?i){ASCII_WORD_BOUNDARY}{}",
                r"(Bearer)\s+[A-Za-z0-9._~+/-]+=*"
            ))
            .expect("fixed literal pattern"),
            "$1 [redacted]",
        ),
        (
            Regex::new(&format!("{ASCII_WORD_BOUNDARY}sk-[A-Za-z0-9_-]{{10,}}"))
                .expect("fixed literal pattern"),
            "[redacted]",
        ),
        // Covers classic GitHub tokens and fine-grained `github_pat_` PATs.
        (
            Regex::new(&format!(
                "{ASCII_WORD_BOUNDARY}{}",
                r"(?:gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,})"
            ))
            .expect("fixed literal pattern"),
            "[redacted]",
        ),
        // Bare JWT, redacted whole.
        (
            Regex::new(&format!(
                "{ASCII_WORD_BOUNDARY}{}",
                r"eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+"
            ))
            .expect("fixed literal pattern"),
            "[redacted]",
        ),
        // Cloud and vendor token shapes with no key name to anchor on.
        (
            Regex::new(&format!(
                "{ASCII_WORD_BOUNDARY}{}{ASCII_WORD_BOUNDARY}",
                r"(?:AKIA|ASIA)[0-9A-Z]{16}"
            ))
            .expect("fixed literal pattern"),
            "[redacted]",
        ),
        (
            Regex::new(&format!("{ASCII_WORD_BOUNDARY}AIza[0-9A-Za-z_-]{{35}}"))
                .expect("fixed literal pattern"),
            "[redacted]",
        ),
        (
            Regex::new(&format!("{ASCII_WORD_BOUNDARY}xox[abposr]-[A-Za-z0-9-]{{10,}}"))
                .expect("fixed literal pattern"),
            "[redacted]",
        ),
        (
            Regex::new(&format!(
                "{ASCII_WORD_BOUNDARY}{}",
                r"(?:glpat-|npm_|hf_)[A-Za-z0-9_-]{16,}"
            ))
            .expect("fixed literal pattern"),
            "[redacted]",
        ),
        (
            Regex::new(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)")
                .expect("fixed literal pattern"),
            "[redacted private key]",
        ),
        // Catches a private-key block whose BEGIN marker fell out of the read window.
        (
            Regex::new(r"^[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----").expect("fixed literal pattern"),
            "[redacted private key]",
        ),
        // Key-name pattern for common secret fields. Bare `key` is handled separately below.
        (
            Regex::new(
                r#"(?i)((?:access|refresh|id|auth)?_?[Tt]oken|x-(?:api|goog-api)-key|api[_-]?key|apikey|password|passwd|pwd|secret|client_secret|credentials?|(?<![A-Za-z])auth)(\\?['"]?\s*[:=]\s*)(\\?"(?:[^"\\\n]|\\.)*\\?"?|'[^'\n]*'?|[^\s&"',}]+)"#,
            )
            .expect("fixed literal pattern"),
            "$1$2[redacted]",
        ),
        // Azure SAS `sig`, limited to query-string form to avoid matching words like "design".
        (
            Regex::new(r"(?i)([?&]sig=)[^&\s]+").expect("fixed literal pattern"),
            "$1[redacted]",
        ),
        // Bare `key` needs case-sensitive alternatives so "monkey" is not redacted.
        (
            Regex::new(
                r#"((?:(?<![A-Za-z])key(?![A-Za-z])|(?<=[a-z0-9])Key(?![A-Za-z])|(?<![A-Za-z])KEY(?![A-Za-z])))(\\?['"]?\s*[:=]\s*)(\\?"(?:[^"\\\n]|\\.)*\\?"?|'[^'\n]*'?|[^\s&"',}]+)"#,
            )
            .expect("fixed literal pattern"),
            "$1$2[redacted]",
        ),
        // Authorization and Cookie header values, including JSON-quoted forms.
        (
            Regex::new(&format!(
                "(?i){ASCII_WORD_BOUNDARY}{}",
                r#"(Authorization|(?:Set-)?Cookie)(\\?['"]?\s*:\s*)(\\?"(?:[^"\\\n]|\\.)*\\?"?|'[^'\n]*'?|[^\n]+)"#
            ))
            .expect("fixed literal pattern"),
            "$1$2[redacted]",
        ),
        // URL userinfo for any scheme, up to the last `@` before the host.
        (
            Regex::new(&format!(
                "(?i){ASCII_WORD_BOUNDARY}{}",
                r"([a-z][a-z0-9+.-]{0,31}://)[^\s/@:]*:[^\s/]*@(?=[^\s/@]*(?:[/:?#\s]|$))"
            ))
            .expect("fixed literal pattern"),
            "$1[redacted]@",
        ),
        // Email last: earlier, it would consume the `@` the URL-userinfo pattern needs.
        (
            Regex::new(&format!(
                "{ASCII_WORD_BOUNDARY}{}{ASCII_WORD_BOUNDARY}",
                r"[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}"
            ))
            .expect("fixed literal pattern"),
            "[email]",
        ),
    ]
});

/// Caps the input so the lookaround patterns stay within `fancy_regex`'s backtrack budget.
const MAX_REDACTION_INPUT_BYTES: usize = 8 * 1024;

/// Returned for the whole text when a pattern hits the backtrack limit. Fails closed.
const REDACTION_FAILURE_PLACEHOLDER: &str = "[diagnostic withheld]";

/// Keeps the last `max_bytes` bytes, dropping any partial line at the cut so no token is split.
fn bound_to_tail_bytes(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_string();
    }
    let mut start = text.len() - max_bytes;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    let tail = &text[start..];
    match tail.find('\n') {
        Some(idx) => format!("[truncated]\n{}", &tail[idx + 1..]),
        None => "[truncated]".to_string(),
    }
}

/// Runs every pattern in order; `Err(())` on the first backtrack-limit error (fail closed).
fn apply_patterns(text: &str) -> Result<String, ()> {
    let mut result = text.to_string();
    for (pattern, replacement) in PATTERNS.iter() {
        result = pattern
            .try_replacen(&result, 0, *replacement)
            .map_err(|_| ())?
            .into_owned();
    }
    Ok(result)
}

/// Redacts credential-shaped substrings from `text`, failing closed to a fixed placeholder.
pub fn redact_secrets(text: &str) -> String {
    let bounded = bound_to_tail_bytes(text, MAX_REDACTION_INPUT_BYTES);
    apply_patterns(&bounded).unwrap_or_else(|()| REDACTION_FAILURE_PLACEHOLDER.to_string())
}

#[cfg(test)]
#[path = "redact_tests.rs"]
mod redact_tests;
