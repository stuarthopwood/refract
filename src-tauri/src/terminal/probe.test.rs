use serde_json::json;

use super::*;

#[test]
fn pattern_has_the_requested_length_and_wraps_at_251() {
    let bytes = pattern(LARGE_FRAME_BYTES);
    assert_eq!(bytes.len(), LARGE_FRAME_BYTES);
    assert_eq!(bytes[0], 0);
    assert_eq!(bytes[250], 250);
    assert_eq!(bytes[251], 0);
}

#[test]
fn a_channel_handle_string_parses() {
    assert!(parse_channel_arg(&[json!("__CHANNEL__:7")]).is_ok());
}

#[test]
fn a_missing_or_malformed_channel_argument_is_invalid() {
    for args in [vec![], vec![json!(5)], vec![json!("not-a-channel")]] {
        let err = parse_channel_arg(&args).expect_err("refused");
        assert_eq!(err.code, "invalid-argument");
    }
}
