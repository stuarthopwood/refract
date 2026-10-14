// Unit tests for `ipc::chat` (lane R4, issue #787; gate-fix round 1): `parse_images_argument`'s
// shape/argument validation AND the Critical security property that it rebuilds a fresh
// `{ type, data, mimeType }` object rather than forwarding the caller's whole entry, plus
// `map_chat_error`'s passthrough. `#[path]`-loaded sibling of `chat.rs` (excluded from
// `check:file-size` by its own `.test.rs` name).

use super::*;
use crate::omp::images::base64_encode;

fn fake_png_base64() -> String {
    let mut bytes = vec![0x89u8, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    bytes.extend_from_slice(&[0, 0, 0, 13]);
    bytes.extend_from_slice(b"IHDR");
    bytes.extend_from_slice(&4u32.to_be_bytes());
    bytes.extend_from_slice(&3u32.to_be_bytes());
    base64_encode(&bytes)
}

#[tokio::test]
async fn parse_images_argument_none_for_absent_or_null() {
    assert!(matches!(parse_images_argument(None).await, Ok(None)));
    assert!(matches!(
        parse_images_argument(Some(&Value::Null)).await,
        Ok(None)
    ));
}

#[tokio::test]
async fn parse_images_argument_rejects_a_non_array() {
    let images = json!("not an array");
    assert!(parse_images_argument(Some(&images)).await.is_err());
}

#[tokio::test]
async fn parse_images_argument_rejects_a_non_object_entry() {
    let images = json!(["not an object"]);
    assert!(parse_images_argument(Some(&images)).await.is_err());
}

#[tokio::test]
async fn parse_images_argument_rejects_wrong_type_field() {
    let images = json!([{ "type": "not-image", "data": "x", "mimeType": "image/png" }]);
    assert!(parse_images_argument(Some(&images)).await.is_err());
}

#[tokio::test]
async fn parse_images_argument_rejects_missing_data() {
    let images = json!([{ "type": "image", "mimeType": "image/png" }]);
    assert!(parse_images_argument(Some(&images)).await.is_err());
}

#[tokio::test]
async fn parse_images_argument_rejects_empty_data() {
    let images = json!([{ "type": "image", "data": "", "mimeType": "image/png" }]);
    assert!(parse_images_argument(Some(&images)).await.is_err());
}

#[tokio::test]
async fn parse_images_argument_rejects_missing_mime_type() {
    let images = json!([{ "type": "image", "data": fake_png_base64() }]);
    let err = parse_images_argument(Some(&images))
        .await
        .expect_err("missing mimeType must be invalid-argument");
    assert_eq!(err.code, "invalid-argument");
}

#[tokio::test]
async fn parse_images_argument_rejects_a_non_string_mime_type() {
    // Gate-fix (Critical, security): a non-string `mimeType` (e.g. a number) must be refused as
    // invalid-argument, never silently coerced or defaulted to an empty string.
    let images = json!([{ "type": "image", "data": fake_png_base64(), "mimeType": 12345 }]);
    let err = parse_images_argument(Some(&images))
        .await
        .expect_err("non-string mimeType must be invalid-argument");
    assert_eq!(err.code, "invalid-argument");
}

#[tokio::test]
async fn parse_images_argument_rejects_an_unsupported_mime_type() {
    let images =
        json!([{ "type": "image", "data": fake_png_base64(), "mimeType": "application/zip" }]);
    let err = parse_images_argument(Some(&images))
        .await
        .expect_err("unsupported mime type must be refused");
    assert_eq!(err.code, "unsupported-image-type");
}

#[tokio::test]
async fn parse_images_argument_accepts_a_valid_image_and_rebuilds_a_fresh_object() {
    // Gate-fix (Critical, security): the output object contains ONLY `type`/`data`/`mimeType` --
    // an extra field the caller attached (`providerFile`, `url`, `detail`, ...) must never reach
    // the outgoing prompt command, even though every shape/mime/size check above it passed.
    let data = fake_png_base64();
    let images = json!([{
        "type": "image",
        "data": data,
        "mimeType": "image/png",
        "providerFile": "sneaky-extra-field",
        "url": "https://attacker.example/exfiltrate"
    }]);
    let parsed = parse_images_argument(Some(&images))
        .await
        .expect("a valid image must be accepted")
        .expect("Some(images)");
    assert_eq!(parsed.len(), 1);
    let rebuilt = parsed[0].as_object().expect("image entry is an object");
    assert_eq!(
        rebuilt.len(),
        3,
        "only type/data/mimeType may survive: got {rebuilt:?}"
    );
    assert_eq!(rebuilt.get("type").and_then(Value::as_str), Some("image"));
    assert_eq!(
        rebuilt.get("mimeType").and_then(Value::as_str),
        Some("image/png")
    );
    assert_eq!(
        rebuilt.get("data").and_then(Value::as_str),
        Some(data.as_str())
    );
    assert!(rebuilt.get("providerFile").is_none());
    assert!(rebuilt.get("url").is_none());
}

#[tokio::test]
async fn parse_images_argument_rejects_an_oversized_pixel_count() {
    let mut bytes = vec![0x89u8, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    bytes.extend_from_slice(&[0, 0, 0, 13]);
    bytes.extend_from_slice(b"IHDR");
    bytes.extend_from_slice(&20000u32.to_be_bytes());
    bytes.extend_from_slice(&20000u32.to_be_bytes());
    let images =
        json!([{ "type": "image", "data": base64_encode(&bytes), "mimeType": "image/png" }]);
    let err = parse_images_argument(Some(&images))
        .await
        .expect_err("an over-cap pixel count must be refused");
    assert_eq!(err.code, "image-too-large");
    assert_eq!(err.message, "Image exceeds the maximum pixel count");
}

// ---------------------------------------------------------------------------
// map_chat_error
// ---------------------------------------------------------------------------

#[test]
fn map_chat_error_passes_code_and_message_through() {
    let agent_err = crate::session::AgentError::new("agent-not-running", "no live process");
    let ipc_err = map_chat_error(agent_err);
    assert_eq!(ipc_err.code, "agent-not-running");
    assert_eq!(ipc_err.message, "no live process");
}

// ---------------------------------------------------------------------------
// is_native_reserved / is_valid_queue_kind / parse_session_id_and_text
// ---------------------------------------------------------------------------

#[test]
fn is_native_reserved_table() {
    for name in [
        "new",
        "resume",
        "plan",
        "fork",
        "settings",
        "pause",
        "plan-review",
        "btw",
    ] {
        assert!(is_native_reserved(name), "{name} must be reserved");
    }
    assert!(!is_native_reserved("usage"));
    assert!(!is_native_reserved("check-build"));
}

#[test]
fn is_valid_queue_kind_table() {
    assert!(is_valid_queue_kind("followUp"));
    assert!(is_valid_queue_kind("steering"));
    assert!(!is_valid_queue_kind(""));
    assert!(!is_valid_queue_kind("FollowUp"));
    assert!(!is_valid_queue_kind("both"));
}

#[test]
fn parse_session_id_and_text_valid() {
    let args = vec![json!("session-1"), json!("hello")];
    assert_eq!(
        parse_session_id_and_text(&args),
        Some(("session-1", "hello"))
    );
}

#[test]
fn parse_session_id_and_text_rejects_missing_or_non_string() {
    assert_eq!(parse_session_id_and_text(&[]), None);
    assert_eq!(parse_session_id_and_text(&[json!("only-one")]), None);
    assert_eq!(parse_session_id_and_text(&[json!(1), json!("text")]), None);
    assert_eq!(
        parse_session_id_and_text(&[json!("session-1"), json!(2)]),
        None
    );
}
