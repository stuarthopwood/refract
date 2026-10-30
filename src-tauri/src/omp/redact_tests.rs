// Fixture tests for `redact_secrets` (#792, split out of `redact.rs` for the file-size cap).
// Credential-shaped fixtures are built from fragments so no literal reads as a live secret.

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
    // AWS access key ID, split so the whole shape is never one literal.
    let aws_key = format!("{}{}", "AKIA", "IOSFODNN7EXAMPLE");
    assert_eq!(redact_secrets(&aws_key), "[redacted]");
    // Bare Google/Gemini API key: `AIza` + exactly 35 chars.
    assert_eq!(
        redact_secrets(&format!("AIza{}", "A".repeat(35))),
        "[redacted]"
    );
    // Slack bot token, split like the AWS key.
    let slack_token = format!("{}{}", "xoxb-", "1234567890-abcdefghijklmnop");
    assert_eq!(redact_secrets(&slack_token), "[redacted]");
    // GitLab PAT, npm token, Hugging Face token.
    assert_eq!(redact_secrets("glpat-1234567890123456"), "[redacted]");
    assert_eq!(redact_secrets("npm_1234567890123456"), "[redacted]");
    assert_eq!(redact_secrets("hf_1234567890123456"), "[redacted]");
}

#[test]
fn full_private_key_block_is_redacted() {
    // BEGIN/END markers split so the PEM block shape is never one literal.
    let begin = format!("{}{}", "-----BEGIN PRIVATE", " KEY-----");
    let end = format!("{}{}", "-----END PRIVATE", " KEY-----");
    let block = format!("{begin}\nc29tZWJhc2U2NGJvZHk=\n{end}");
    assert_eq!(redact_secrets(&block), "[redacted private key]");
}

#[test]
fn truncated_tail_with_no_begin_marker_is_still_redacted() {
    // A window starting partway through a key block must still redact up to the END marker.
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
    // A value escaped a level deeper (JSON error body inside a quoted log field) still redacts;
    // an escaped closing quote is content, not a terminator.
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
    // An unterminated value still redacts, but stops at the newline.
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
    // "OAuth: failed to refresh": bare `auth` inside "OAuth:" is not the `auth` key pattern.
    assert_eq!(
        redact_secrets("OAuth: failed to refresh"),
        "OAuth: failed to refresh"
    );
}

#[test]
fn camel_case_key_names_still_redact() {
    // camelCase key forms must redact.
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
    // Bare upper-case `KEY` (`PRIVATE_KEY`) and camelCase `Key` (`secretKey`) use the bare-`key` pattern.
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
    // Upper-case `SET-COOKIE:` must redact too.
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
    // A raw `@` inside the password must not truncate the match; redaction stops at the last
    // unescaped `@` before the host.
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
    // The email pattern must not consume the `@` the URL userinfo pattern needs.
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
    // The TS `\b` is ASCII-only but `fancy_regex`'s is Unicode-aware; a token after a non-ASCII
    // letter must still redact. Split fragments keep the token from being one literal.
    let token = format!("{}{}", "sk-ant-api03-", "1234567890abcdef");
    let input = format!("Ω{token}");
    assert_eq!(redact_secrets(&input), "Ω[redacted]");
}

#[test]
fn bound_to_tail_bytes_caps_length_and_respects_char_boundaries() {
    assert_eq!(super::bound_to_tail_bytes("short", 100), "short");
    // No newline in the window: nothing survives the cut ("maybe mid-token").
    assert_eq!(
        super::bound_to_tail_bytes(&"a".repeat(20), 5),
        "[truncated]"
    );
    // "é" is 2 bytes; a cut at byte 3 lands inside it and must advance to the next char boundary.
    let multi_byte = "abécd";
    assert_eq!(multi_byte.len(), 6);
    let bounded = super::bound_to_tail_bytes(multi_byte, 3);
    assert_eq!(bounded, "[truncated]"); // "cd" alone has no newline to cut at either
}

/// A cut landing mid-token must not leave a credential fragment: everything up to the first
/// newline in the bounded window is dropped.
#[test]
fn truncation_never_splits_a_credential_mid_token() {
    let token = format!("sk-{}", "a".repeat(40));
    let text = format!("{}{}\nsafe trailing line", "x".repeat(50), token);
    // Chosen so the cut lands inside `token` itself, not before or after it.
    let bounded = super::bound_to_tail_bytes(&text, 30);
    assert_eq!(bounded, "[truncated]\nsafe trailing line");
    assert!(!bounded.contains("sk-"));
    assert!(!bounded.contains("aaa")); // no leaked run of the token's filler characters
}

#[test]
fn backtrack_limit_exhaustion_fails_closed_with_the_placeholder() {
    // A dense near-miss `key` shape forces the lookaround patterns to be tried at every position.
    // It needs tens of KB to exceed the default backtrack budget, past the 8 KiB input bound, so
    // this drives `apply_patterns` directly to prove the fail-closed fallback.
    let adversarial = "xkeyx".repeat(12_800); // 64,000 bytes: well past the 8 KiB bound
    assert!(
        adversarial.len() > super::MAX_REDACTION_INPUT_BYTES,
        "fixture must exceed the bound for this test's framing to hold"
    );
    assert!(
        super::apply_patterns(&adversarial).is_err(),
        "expected this input to exceed fancy_regex's backtrack limit"
    );
    // The fallback expression `redact_secrets` evaluates on an `Err`: a fixed placeholder.
    let result = super::apply_patterns(&adversarial)
        .unwrap_or_else(|()| super::REDACTION_FAILURE_PLACEHOLDER.to_string());
    assert_eq!(result, "[diagnostic withheld]");
}
