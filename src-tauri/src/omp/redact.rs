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

use std::sync::LazyLock;

use fancy_regex::Regex;

/// Every pattern/replacement pair, applied in order by `redact_secrets`. Compiled once: every
/// pattern here is a fixed literal known at compile time, so `.expect(...)` at this init site is
/// safe -- it never runs on untrusted input, only once, at first use, over this hardcoded list.
static PATTERNS: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
    vec![
        // Bearer tokens. No trailing `\b` on the value: Anthropic/OpenAI keys embed hyphens
        // (sk-ant-api03-..., sk-proj-...), which a word boundary would stop matching mid-key.
        (
            Regex::new(r"(?i)\b(Bearer)\s+[A-Za-z0-9._~+/-]+=*").expect("fixed literal pattern"),
            "$1 [redacted]",
        ),
        (
            Regex::new(r"\bsk-[A-Za-z0-9_-]{10,}").expect("fixed literal pattern"),
            "[redacted]",
        ),
        // `gh[pousr]_` covers personal/oauth/user/server/refresh tokens; `github_pat_` covers
        // fine-grained PATs. Kept at the original 10-char minimum (not a stricter real-world
        // length) so this still matches the shorter tokens the existing tests use.
        (
            Regex::new(r"\b(?:gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,})")
                .expect("fixed literal pattern"),
            "[redacted]",
        ),
        // Bare JWT: three dot-separated base64url segments, each starting `eyJ` (a base64'd
        // `{"`). Redacted whole: unlike the key=value forms below, there is no key name worth
        // preserving.
        (
            Regex::new(r"\beyJ[\w-]+\.eyJ[\w-]+\.[\w-]+").expect("fixed literal pattern"),
            "[redacted]",
        ),
        // Gate-fixes security Medium finding (cycle 5): AWS access key IDs, bare Google/Gemini
        // API keys (omp has a Google provider), Slack tokens, GitLab/npm/Hugging Face tokens,
        // and PEM private-key blocks all passed through unredacted.
        (
            Regex::new(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b").expect("fixed literal pattern"),
            "[redacted]",
        ),
        (
            Regex::new(r"\bAIza[0-9A-Za-z_-]{35}").expect("fixed literal pattern"),
            "[redacted]",
        ),
        (
            Regex::new(r"\bxox[abposr]-[A-Za-z0-9-]{10,}").expect("fixed literal pattern"),
            "[redacted]",
        ),
        (
            Regex::new(r"\b(?:glpat-|npm_|hf_)[A-Za-z0-9_-]{16,}").expect("fixed literal pattern"),
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
            Regex::new(
                r#"(?i)\b(Authorization|(?:Set-)?Cookie)(\\?['"]?\s*:\s*)(\\?"(?:[^"\\\n]|\\.)*\\?"?|'[^'\n]*'?|[^\n]+)"#,
            )
            .expect("fixed literal pattern"),
            "$1$2[redacted]",
        ),
        // Generic scheme (not just http/https) userinfo: mongodb+srv://, postgres://, redis://,
        // wss://, ... -- redacts up to the LAST unescaped `@` before the host (greedy
        // `[^\s/]*` backtracks to find it), so a raw `@` inside the password itself no longer
        // leaks a trailing fragment; an empty username (`redis://:pw@host`) is still allowed.
        // Scheme bounded to 31 chars against pathological input.
        (
            Regex::new(r"(?i)\b([a-z][a-z0-9+.-]{0,31}://)[^\s/@:]*:[^\s/]*@(?=[^\s/@]*(?:[/:?#\s]|$))")
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
            Regex::new(
                r"\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}\b",
            )
            .expect("fixed literal pattern"),
            "[email]",
        ),
    ]
});

/// Pure text transform: runs every pattern over `text` in order and returns the redacted
/// result. Never panics and never aborts the chain -- if a single pattern's replace errors
/// (e.g. `fancy_regex`'s backtrack limit on pathological input), that one pattern is skipped
/// unapplied and every other pattern in the chain still runs.
pub fn redact_secrets(text: &str) -> String {
    let mut result = text.to_string();
    for (pattern, replacement) in PATTERNS.iter() {
        result = match pattern.try_replacen(&result, 0, *replacement) {
            Ok(replaced) => replaced.into_owned(),
            Err(_) => result,
        };
    }
    result
}

#[cfg(test)]
#[path = "redact_tests.rs"]
mod redact_tests;
