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
    let result = redact_secrets(r#"{"Cookie":"sid=abc"}"#);
    assert!(
        result.contains("[redacted]"),
        "expected Cookie value redacted, got {result:?}"
    );
    assert!(
        !result.contains("sid=abc"),
        "expected Cookie value not to leak, got {result:?}"
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
