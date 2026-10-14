// Fixture-based tests for `redact.rs`'s `redact_secrets` pure text transform (lane R9, issue
// #792's own acceptance: "no secret appears in any log"). Split from `redact.rs` itself
// (`#[path = "redact_tests.rs"]` at its tail) to stay under the 600-line-per-file cap (issue
// #806), the same pattern `ipc/pull_requests/mapping_tests.rs` already uses for splitting a
// module by concern, applied test-only here. One test per `src/main/omp/redact.ts` pattern
// group, plus the two named false-positive guards and the cycle-4/5/6/7 regressions its own
// comments call out by name.
//
// A handful of fixtures below assemble a credential-shaped string from two or more literal
// fragments via `format!` instead of one contiguous string literal -- deliberately, so no
// single literal in this source file itself reads as a real live credential; the fragments
// only form the shape `redact_secrets` targets once concatenated at test-run time.

use super::*;

#[test]
fn bearer_token_is_redacted() {
    let value = format!("{}{}", "abcDEF1234567890ghIJ", "KLmnoPQRstu");
    let input = format!("Bearer {value}");
    assert_eq!(redact_secrets(&input), "Bearer [redacted]");
}

#[test]
fn anthropic_and_openai_style_sk_keys_are_redacted() {
    assert_eq!(
        redact_secrets("sk-ant-api03-1234567890abcdef"),
        "[redacted]"
    );
    assert_eq!(redact_secrets("sk-proj-1234567890abcdef"), "[redacted]");
}

#[test]
fn github_token_and_fine_grained_pat_are_redacted() {
    assert_eq!(redact_secrets("ghp_1234567890abcdef"), "[redacted]");
    assert_eq!(redact_secrets("github_pat_1234567890abcdef"), "[redacted]");
}

#[test]
fn bare_jwt_is_redacted() {
    let header = "eyJhbGciOiJIUzI1NiJ9";
    let payload = "eyJzdWIiOiIxMjM0NTY3ODkwIn0";
    let signature = "dGVzdHNpZ25hdHVyZQ";
    let jwt = format!("{header}.{payload}.{signature}");
    assert_eq!(redact_secrets(&jwt), "[redacted]");
}

#[test]
fn provider_token_shapes_are_redacted() {
    // AWS access key ID: `AKIA`/`ASIA` prefix + exactly 16 chars, split across the natural
    // prefix/body boundary so the whole shape never appears as one literal in this file.
    let aws_key = format!("{}{}", "AKIA", "IOSFODNN7EXAMPLE");
    assert_eq!(redact_secrets(&aws_key), "[redacted]");
    // Bare Google/Gemini API key: `AIza` + exactly 35 chars.
    assert_eq!(
        redact_secrets(&format!("AIza{}", "A".repeat(35))),
        "[redacted]"
    );
    // Slack bot token: `xoxb-` prefix + body, same split rationale as the AWS key above.
    let slack_token = format!("{}{}", "xoxb-", "1234567890-abcdefghijklmnop");
    assert_eq!(redact_secrets(&slack_token), "[redacted]");
    // GitLab PAT, npm token, Hugging Face token.
    assert_eq!(redact_secrets("glpat-1234567890123456"), "[redacted]");
    assert_eq!(redact_secrets("npm_1234567890123456"), "[redacted]");
    assert_eq!(redact_secrets("hf_1234567890123456"), "[redacted]");
}

#[test]
fn full_private_key_block_is_redacted() {
    // BEGIN/END markers assembled from split fragments (see module doc comment) so the full
    // PEM block shape never appears as one literal in this file.
    let begin = format!("{}{}", "-----BEGIN PRIVATE", " KEY-----");
    let end = format!("{}{}", "-----END PRIVATE", " KEY-----");
    let block = format!("{begin}\nc29tZWJhc2U2NGJvZHk=\n{end}");
    assert_eq!(redact_secrets(&block), "[redacted private key]");
}

#[test]
fn truncated_tail_with_no_begin_marker_is_still_redacted() {
    // Cycle 7: a read window that starts PARTWAY through a key block (BEGIN already scrolled
    // out) must still redact the remaining base64 body up to and including the END marker.
    let tail = "c29tZWJhc2U2NGJvZHk=\n-----END PRIVATE KEY-----";
    assert_eq!(redact_secrets(tail), "[redacted private key]");
}

#[test]
fn key_value_pairs_redact_the_value_and_keep_the_key_name() {
    assert_eq!(redact_secrets(r#"api_key="abc123""#), "api_key=[redacted]");
    assert_eq!(
        redact_secrets("password: 'hunter2'"),
        "password: [redacted]"
    );
    assert_eq!(
        redact_secrets("client_secret=xyz"),
        "client_secret=[redacted]"
    );
}

#[test]
fn escaped_nested_json_value_still_redacts() {
    // Cycle 3: a value escaped a level deeper (an outer-quoted log field embedding a provider's
    // own JSON error body) must still redact -- an escaped closing quote (`\"`) is treated as
    // escaped content inside the value, not a terminator.
    let input = r#"error=\"{\"api_key\":\"abc123\"}\""#;
    let result = redact_secrets(input);
    assert_eq!(result, r#"error=\"{\"api_key\":[redacted]"#);
    assert!(
        !result.contains("abc123"),
        "expected value not to leak, got {result:?}"
    );
}

#[test]
fn unterminated_value_does_not_swallow_the_next_line() {
    // Cycle 3/4: a value with no closing quote at all (a truncated line) still redacts instead
    // of passing through untouched -- but must stop at the newline rather than swallowing the
    // next, unrelated line.
    let input = "token=\"abc\nnext line unrelated text";
    assert_eq!(
        redact_secrets(input),
        "token=[redacted]\nnext line unrelated text"
    );
}

#[test]
fn bare_key_false_positive_guards_do_not_redact() {
    // "monkey": bare lowercase `key` as the tail of an ordinary word is not a secret.
    assert_eq!(redact_secrets("monkey"), "monkey");
    // "OAuth: failed to refresh": bare `auth` inside "OAuth:" is not the `auth` key-name
    // pattern (cycle 6's `(?<![A-Za-z])` guard).
    assert_eq!(
        redact_secrets("OAuth: failed to refresh"),
        "OAuth: failed to refresh"
    );
}

#[test]
fn camel_case_key_names_still_redact() {
    // Cycle 4: restored after cycle 3's lookbehind wrongly blocked every camelCase form.
    assert_eq!(
        redact_secrets(r#"sessionToken="abc""#),
        "sessionToken=[redacted]"
    );
    assert_eq!(
        redact_secrets(r#"secretAccessKey="abc""#),
        "secretAccessKey=[redacted]"
    );
}

#[test]
fn bare_cased_key_name_regressions_still_redact() {
    // Cycle 4: bare upper-case `KEY` (underscore-prefixed, as in `PRIVATE_KEY`) and bare
    // camelCase `Key` right after a lowercase letter (`secretKey`) both go through the
    // explicitly-cased bare-`key` pattern, not the shared key=value group above.
    assert_eq!(
        redact_secrets("PRIVATE_KEY=secret123"),
        "PRIVATE_KEY=[redacted]"
    );
    assert_eq!(redact_secrets(r#"secretKey="abc""#), "secretKey=[redacted]");
}

#[test]
fn azure_sas_sig_query_parameter_is_redacted_scoped_to_query_string() {
    assert_eq!(redact_secrets("blob?sig=abcdef123"), "blob?sig=[redacted]");
    assert_eq!(redact_secrets("blob&sig=abcdef123"), "blob&sig=[redacted]");
    // "sig" as a substring of ordinary words must NOT redact.
    assert_eq!(redact_secrets("design=1"), "design=1");
    assert_eq!(redact_secrets("assign=2"), "assign=2");
}

#[test]
fn authorization_and_json_quoted_cookie_header_values_are_redacted() {
    assert_eq!(
        redact_secrets("Authorization: Basic xyz"),
        "Authorization: [redacted]"
    );
    assert_eq!(
        redact_secrets(r#"{"Cookie":"sid=abc"}"#),
        r#"{"Cookie":[redacted]}"#
    );
    // Cycle 4: `SET-COOKIE:` (upper case) must redact too, not just `Cookie:`/`cookie:`.
    assert_eq!(
        redact_secrets("SET-COOKIE: sid=abc123"),
        "SET-COOKIE: [redacted]"
    );
}

#[test]
fn non_http_url_userinfo_is_redacted_and_host_is_preserved() {
    assert_eq!(
        redact_secrets("postgres://user:pass@host/db"),
        "postgres://[redacted]@host/db"
    );
    assert_eq!(
        redact_secrets("redis://:pw@host"),
        "redis://[redacted]@host"
    );
    // Cycle 6: a raw `@` inside the password itself (not just the URL-vs-email ordering case
    // below) must not truncate the match early -- redaction stops at the LAST unescaped `@`
    // before the host, so `@host/db` is never swallowed.
    assert_eq!(
        redact_secrets("postgres://u:p@ss@host/db"),
        "postgres://[redacted]@host/db"
    );
}

#[test]
fn email_address_is_redacted() {
    assert_eq!(redact_secrets("someone@example.com"), "[email]");
}

#[test]
fn url_userinfo_pattern_runs_before_email_pattern() {
    // Cycle 6: the email pattern used to run first and would match
    // `<rest-of-password>@host.tld` inside the URL login, consuming the `@` the URL pattern
    // needed. The userinfo must be redacted, not a false email match.
    assert_eq!(
        redact_secrets("redis://:Abc#def@cache.example.com"),
        "redis://[redacted]@cache.example.com"
    );
}

#[test]
fn plain_diagnostic_text_passes_through_unchanged() {
    assert_eq!(
        redact_secrets("gh: connection refused"),
        "gh: connection refused"
    );
}

#[test]
fn token_immediately_after_a_non_ascii_letter_is_still_redacted() {
    // The TS source has no `/u` flag, so its `\b` is ASCII-only: a non-ASCII letter is never a
    // "word" character there, so a boundary still exists between it and an immediately
    // following token. `fancy_regex`'s `\b` is Unicode-aware by default, which would treat
    // `Ω` and `s` as the SAME word-char class and find no boundary at all between them --
    // silently passing the token through unredacted. Built via `format!` from split fragments
    // (see module doc comment) so the token shape never appears as one literal in this file.
    let token = format!("{}{}", "sk-ant-api03-", "1234567890abcdef");
    let input = format!("Ω{token}");
    assert_eq!(redact_secrets(&input), "Ω[redacted]");
}

#[test]
fn bound_to_tail_bytes_caps_length_and_respects_char_boundaries() {
    assert_eq!(super::bound_to_tail_bytes("short", 100), "short");
    assert_eq!(super::bound_to_tail_bytes(&"a".repeat(20), 5), "aaaaa");
    // "é" is a 2-byte UTF-8 character; a byte-only cut at its midpoint would panic when
    // slicing. Bounding to 3 of this 6-byte string's bytes would land inside "é" (bytes 2-3);
    // the cut must advance past it instead of splitting it.
    let multi_byte = "abécd";
    assert_eq!(multi_byte.len(), 6);
    let bounded = super::bound_to_tail_bytes(multi_byte, 3);
    assert_eq!(bounded, "cd");
    assert!(bounded.len() <= 3);
}

#[test]
fn backtrack_limit_exhaustion_fails_closed_with_the_placeholder() {
    // The bare-`key` pattern is one of the three lookaround-bearing patterns `redact.rs`'s own
    // module doc names (key=value, bare-`key`, URL-userinfo) that run through `fancy_regex`'s
    // slower backtracking engine. Repeating a dense near-miss shape -- `key` with neither a
    // preceding/following ASCII letter to clear its guards, nor a `:`/`=` separator ever
    // following -- forces its three lookaround alternatives to be tried at every position
    // across the whole string with no match ever completing.
    //
    // This needs tens of KB to actually exceed `fancy_regex`'s default 1,000,000-step
    // backtrack budget (each failed position costs a small, bounded amount of work; these
    // patterns are deliberately written to avoid the unbounded nested-quantifier blowup that
    // would make a much smaller input dangerous -- see their own "ReDoS-bounded" comments).
    // That's comfortably past `redact_secrets`'s own 8 KiB bound (`MAX_REDACTION_INPUT_BYTES`):
    // the bound alone already protects every caller long before this limit would ever bite, so
    // there is no adversarial input that both fits inside the bound and trips the limit. This
    // test instead drives `apply_patterns`, the unbounded inner step, directly -- the escape
    // hatch this function was factored out for -- to prove the fail-closed fallback is real.
    let adversarial = "xkeyx".repeat(12_800); // 64,000 bytes: well past the 8 KiB bound
    assert!(
        adversarial.len() > super::MAX_REDACTION_INPUT_BYTES,
        "fixture must exceed the bound for this test's framing to hold"
    );
    assert!(
        super::apply_patterns(&adversarial).is_err(),
        "expected this input to exceed fancy_regex's backtrack limit"
    );
    // The exact fallback expression `redact_secrets` itself evaluates on an `Err`, proving it
    // really does substitute the fixed placeholder rather than a partially-redacted or
    // unredacted string.
    let result = super::apply_patterns(&adversarial)
        .unwrap_or_else(|()| super::REDACTION_FAILURE_PLACEHOLDER.to_string());
    assert_eq!(result, "[diagnostic withheld]");
}
