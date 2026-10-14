// Rust port of `src/main/omp/redact.ts`'s `redactSecrets`: strips credential-shaped substrings
// from diagnostic text (stderr tails, omp log tails, transcript notices, `stopDetail`, or any
// other IPC payload) before it reaches the renderer or a log -- issue #792's own acceptance:
// "no secret appears in any log". Ported pattern-for-pattern, in the SAME order, from the TS
// `PATTERNS` array: order matters -- the URL-userinfo pattern must run before the email pattern
// (a URL login's `@` would otherwise get consumed by the email pattern first, per the TS
// comment), and the private-key BEGIN pattern must run before its own END-only fallback (so a
// properly terminated block is never double-matched).
//
// Several TS patterns use lookahead/lookbehind (`(?<!...)`, `(?<=...)`, `(?!...)`), which the
// `regex` crate does not support by design -- hence the `fancy-regex` dependency (see
// `Cargo.toml`'s own comment on that line). Each pattern below carries a condensed version of
// its TS comment; read `src/main/omp/redact.ts` itself for the full seven-cycle security-
// hardening history this array embodies (ReDoS-bounded quantifiers, the "monkey" vs
// `secretKey`/`PRIVATE_KEY` false-positive guards, escaped-quote handling for JSON-nested
// values, and the URL-userinfo-vs-email ordering fix).
//
// The TS source has no `u` (unicode) flag on any pattern, so its own `\b`/`\w` are ASCII-only
// (a JS non-`/u` regex never treats a non-ASCII letter as a word character). `fancy_regex`'s
// `\b`/`\w` are Unicode-aware by default, which is a behaviour change, not a straight port: a
// credential immediately preceded by a non-ASCII letter would have no word boundary under
// Rust's Unicode-aware `\b` and silently pass through unredacted. Every pattern below that
// relies on a `\b` boundary or a `\w` character class uses the ASCII-only forms instead:
// `ASCII_WORD_BOUNDARY` below (spelled out via lookaround, since `fancy_regex` refuses to
// change Unicode mode inline -- `(?-u:...)`/`(?u:...)` both hit its own
// `ChangingUnicodeModeUnsupported` parse error, so there's no inline-flag shortcut) in place of
// a bare `\b`, and an explicit `[A-Za-z0-9_]` character class in place of `\w`.

use std::sync::LazyLock;

use fancy_regex::Regex;

/// ASCII-only word-boundary assertion: ports the TS source's own (no `/u` flag) `\b` semantics,
/// which only ever treats `[A-Za-z0-9_]` as a word character. Spelled out as an explicit
/// lookaround rather than an inline Unicode-mode toggle because `fancy_regex` parses
/// `(?-u:...)`/`(?u:...)` as `ChangingUnicodeModeUnsupported` -- it has no inline-flag
/// equivalent of `RegexBuilder::unicode_mode`, so per-pattern ASCII boundaries can only be
/// expressed this way. A position is a boundary when exactly one side is an ASCII word
/// character: either not-preceded-by-and-followed-by one (word starts here), or
/// preceded-by-and-not-followed-by one (word ends here).
const ASCII_WORD_BOUNDARY: &str =
    r"(?:(?<![A-Za-z0-9_])(?=[A-Za-z0-9_])|(?<=[A-Za-z0-9_])(?![A-Za-z0-9_]))";

/// Every pattern/replacement pair, applied in order by `redact_secrets`. Compiled once: every
/// pattern here is a fixed literal known at compile time, so `.expect(...)` at this init site is
/// safe -- it never runs on untrusted input, only once, at first use, over this hardcoded list.
static PATTERNS: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
    vec![
        // Bearer tokens. No trailing `\b` on the value: Anthropic/OpenAI keys embed hyphens
        // (sk-ant-api03-..., sk-proj-...), which a word boundary would stop matching mid-key.
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
        // `gh[pousr]_` covers personal/oauth/user/server/refresh tokens; `github_pat_` covers
        // fine-grained PATs. Kept at the original 10-char minimum (not a stricter real-world
        // length) so this still matches the shorter tokens the existing tests use.
        (
            Regex::new(&format!(
                "{ASCII_WORD_BOUNDARY}{}",
                r"(?:gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,})"
            ))
            .expect("fixed literal pattern"),
            "[redacted]",
        ),
        // Bare JWT: three dot-separated base64url segments, each starting `eyJ` (a base64'd
        // `{"`). Redacted whole: unlike the key=value forms below, there is no key name worth
        // preserving.
        (
            Regex::new(&format!(
                "{ASCII_WORD_BOUNDARY}{}",
                r"eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+"
            ))
            .expect("fixed literal pattern"),
            "[redacted]",
        ),
        // Gate-fixes security Medium finding (cycle 5): AWS access key IDs, bare Google/Gemini
        // API keys (omp has a Google provider), Slack tokens, GitLab/npm/Hugging Face tokens,
        // and PEM private-key blocks all passed through unredacted.
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
        // Gate-fixes security Low finding (cycle 7): a 64 KiB read window (or the stderr
        // sliding window) can start PARTWAY through a private-key block, after its BEGIN marker
        // already scrolled out -- the pattern above needs BEGIN to fire at all, so the
        // remaining base64 body plus the END marker passed through unredacted. Runs AFTER the
        // BEGIN pattern (so a properly terminated block is never double-matched): any leftover
        // END marker with no BEGIN before it redacts everything up to and including it.
        (
            Regex::new(r"^[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----").expect("fixed literal pattern"),
            "[redacted private key]",
        ),
        // One key-name pattern covering api_key/apikey/x-api-key/x-goog-api-key/token (and
        // underscore-prefixed access_token/refresh_token/id_token/auth_token, and their
        // camelCase equivalents)/password/passwd/pwd/secret/client_secret/credential(s)/auth
        // (and camelCase: clientSecret, secretAccessKey, dbPassword, userPassword, ...). No
        // lookbehind on the shared group (cycle 2 behaviour, restored) -- `key` alone is
        // handled by its own pattern below, where the "monkey" false-positive actually lives.
        // The separator/value groups tolerate an optional leading backslash and leading quote
        // (JS-object `'Authorization': 'Basic xyz'`-style quoting); the value group treats `\"`
        // as an escaped character inside the value rather than a terminator, excludes newlines,
        // and its closing quote is optional (a truncated line still redacts instead of passing
        // through untouched). Bare `auth` is preceded by `(?<![A-Za-z])` (cycle 6) so it doesn't
        // match the "auth" substring inside "OAuth:".
        (
            Regex::new(
                r#"(?i)((?:access|refresh|id|auth)?_?[Tt]oken|x-(?:api|goog-api)-key|api[_-]?key|apikey|password|passwd|pwd|secret|client_secret|credentials?|(?<![A-Za-z])auth)(\\?['"]?\s*[:=]\s*)(\\?"(?:[^"\\\n]|\\.)*\\?"?|'[^'\n]*'?|[^\s&"',}]+)"#,
            )
            .expect("fixed literal pattern"),
            "$1$2[redacted]",
        ),
        // Azure SAS `sig` query parameter, scoped to the query-string shape (`?sig=`/`&sig=`)
        // rather than a bare key-name alternative: "sig" is a substring of ordinary words
        // (design, signature, assign), which the main key-name pattern above would otherwise
        // false-positive on.
        (
            Regex::new(r"(?i)([?&]sig=)[^&\s]+").expect("fixed literal pattern"),
            "$1[redacted]",
        ),
        // `key` alone, split out from the group above: a single case-insensitive alternative
        // cannot tell "monkey" (lowercase `key` as the tail of an ordinary word -- must NOT
        // redact) apart from "secretKey"/"privateKey" (camelCase `Key` right after a
        // lowercase/digit boundary -- MUST redact) or `PRIVATE_KEY` (bare upper-case `KEY` --
        // MUST redact), because `/i` makes `[a-z]`/`[A-Z]` equivalent inside a lookbehind. Each
        // case is its own explicitly-cased alternative instead -- no `(?i)` on this one.
        (
            Regex::new(
                r#"((?:(?<![A-Za-z])key(?![A-Za-z])|(?<=[a-z0-9])Key(?![A-Za-z])|(?<![A-Za-z])KEY(?![A-Za-z])))(\\?['"]?\s*[:=]\s*)(\\?"(?:[^"\\\n]|\\.)*\\?"?|'[^'\n]*'?|[^\s&"',}]+)"#,
            )
            .expect("fixed literal pattern"),
            "$1$2[redacted]",
        ),
        // Authorization and Cookie/Set-Cookie header VALUES, including JSON/JS-object-quoted
        // forms and any case (`COOKIE:`, `SET-COOKIE:`) -- the same separator/value shape as
        // the key=value pattern above, so an escaped or JSON-quoted header value redacts
        // exactly like any other credential field instead of only matching a bare line.
        (
            Regex::new(&format!(
                "(?i){ASCII_WORD_BOUNDARY}{}",
                r#"(Authorization|(?:Set-)?Cookie)(\\?['"]?\s*:\s*)(\\?"(?:[^"\\\n]|\\.)*\\?"?|'[^'\n]*'?|[^\n]+)"#
            ))
            .expect("fixed literal pattern"),
            "$1$2[redacted]",
        ),
        // Generic scheme (not just http/https) userinfo: mongodb+srv://, postgres://, redis://,
        // wss://, ... -- redacts up to the LAST unescaped `@` before the host (greedy
        // `[^\s/]*` backtracks to find it), so a raw `@` inside the password itself no longer
        // leaks a trailing fragment; an empty username (`redis://:pw@host`) is still allowed.
        // Scheme bounded to 31 chars against pathological input.
        (
            Regex::new(&format!(
                "(?i){ASCII_WORD_BOUNDARY}{}",
                r"([a-z][a-z0-9+.-]{0,31}://)[^\s/@:]*:[^\s/]*@(?=[^\s/@]*(?:[/:?#\s]|$))"
            ))
            .expect("fixed literal pattern"),
            "$1[redacted]@",
        ),
        // Gate-fixes security Medium finding (cycle 5, moved + bounded cycle 6): email
        // addresses. Moved to LAST: running before the URL-userinfo pattern let it match
        // `<rest-of-password>@host.tld` inside a URL login first, consuming the `@` the URL
        // pattern needed and leaving most of the password unredacted. Character classes are
        // bounded (local part, each domain label, and the TLD) against unbounded-repetition
        // cost.
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

/// Diagnostic text handed to `redact_secrets` can be arbitrarily large (a full stderr tail, omp
/// log tail, ...), and three of the patterns above -- the key=value pattern, the bare-`key`
/// pattern, and the URL-userinfo pattern (see `redact_tests.rs`'s own test driving this) --
/// carry lookaround and run through `fancy_regex`'s slower backtracking engine instead of the
/// `regex` crate's linear-time one. A sufficiently large -- crafted or simply very long --
/// input can run a single `try_replacen` call past `fancy_regex`'s default 1,000,000-step
/// backtrack budget. Bounding to a fixed recent-history window keeps the worst-case scan cost
/// bounded regardless of how much text the caller hands in; 8 KiB holds comfortably more than
/// a diagnostic notice needs to show.
const MAX_REDACTION_INPUT_BYTES: usize = 8 * 1024;

/// Fixed stand-in returned for the WHOLE text when any single pattern's `try_replacen` errors
/// (the backtrack limit was hit). `fancy_regex` erroring means it could not prove the already-
/// bounded text is credential-free, not that it proved it is -- passing the partially-redacted
/// text through, or continuing the chain on a string that just proved expensive to scan, would
/// both risk leaking a secret past a boundary whose entire job is to never do that. Fail closed
/// instead: drop the whole text rather than gamble on what's left of it.
const REDACTION_FAILURE_PLACEHOLDER: &str = "[diagnostic withheld]";

/// Trims `text` to at most its last `max_bytes` bytes, advancing the cut point forward to the
/// next UTF-8 char boundary so a multi-byte character already inside the window is never split.
fn bound_to_tail_bytes(text: &str, max_bytes: usize) -> &str {
    if text.len() <= max_bytes {
        return text;
    }
    let mut start = text.len() - max_bytes;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    &text[start..]
}

/// Runs every pattern over `text` in order. Returns `Err(())` the moment any single pattern's
/// `try_replacen` errors instead of skipping that pattern and letting the remaining chain run
/// on a string that just proved expensive to scan -- the caller (`redact_secrets`) is the one
/// that turns that `Err` into the fixed fail-closed placeholder. Factored out from
/// `redact_secrets` so a test can drive this unbounded step directly with an adversarial input.
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

/// Pure text transform: bounds `text` to its last `MAX_REDACTION_INPUT_BYTES` bytes (see that
/// constant), then runs every pattern over the bounded text in order and returns the redacted
/// result. Fails closed: if any single pattern errors on the bounded text (`fancy_regex`'s
/// backtrack limit was hit), returns `REDACTION_FAILURE_PLACEHOLDER` for the whole text rather
/// than a partially-redacted or unredacted string.
pub fn redact_secrets(text: &str) -> String {
    let bounded = bound_to_tail_bytes(text, MAX_REDACTION_INPUT_BYTES);
    apply_patterns(bounded).unwrap_or_else(|()| REDACTION_FAILURE_PLACEHOLDER.to_string())
}

#[cfg(test)]
#[path = "redact_tests.rs"]
mod redact_tests;
