// Test suite for `store::settings`, split out to keep `settings.rs` under the size cap.
use super::*;

/// A fresh, uniquely-named scratch directory under the OS temp root, never deleted.
async fn open_scratch_store(initial_json: Option<Value>) -> SettingsStore {
    let dir = crate::test_scratch::path(format!("refract-settings-test-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&dir)
        .await
        .expect("create scratch dir");
    if let Some(json) = initial_json {
        tokio::fs::write(
            dir.join("settings.json"),
            serde_json::to_vec(&json).unwrap(),
        )
        .await
        .expect("write scratch settings.json");
    }
    SettingsStore::open(&dir).await.expect("open scratch store")
}

#[tokio::test]
async fn transcript_display_defaults_on_a_brand_new_settings_json() {
    let store = open_scratch_store(None).await;
    assert!(store.get().transcript_display.thinking);
    assert!(store.get().transcript_display.tool_calls);
}

#[tokio::test]
async fn transcript_display_fills_in_default_when_key_is_missing() {
    let store = open_scratch_store(Some(json!({
        "version": 1, "approvalMode": "ask", "sessionReadout": {}, "split": null,
        "theme": "dark", "watermarkEnabled": true
    })))
    .await;
    assert!(store.get().transcript_display.thinking);
    assert!(store.get().transcript_display.tool_calls);
}

#[tokio::test]
async fn transcript_display_falls_back_to_default_on_malformed_shapes() {
    for malformed in [
        json!(5),
        json!("yes"),
        json!([]),
        json!({ "thinking": "yes" }),
        json!({ "thinking": true }),
        Value::Null,
    ] {
        let store = open_scratch_store(Some(json!({
            "version": 1, "approvalMode": "ask", "sessionReadout": {}, "split": null,
            "theme": "dark", "watermarkEnabled": true, "transcriptDisplay": malformed
        })))
        .await;
        assert!(store.get().transcript_display.thinking);
        assert!(store.get().transcript_display.tool_calls);
    }
}

#[tokio::test]
async fn set_transcript_display_merges_one_field_without_touching_the_other() {
    let mut store = open_scratch_store(None).await;
    store
        .set_transcript_display("thinking", false)
        .await
        .unwrap();
    let after = store
        .set_transcript_display("toolCalls", false)
        .await
        .unwrap();
    assert!(!after.transcript_display.thinking);
    assert!(!after.transcript_display.tool_calls);
}

#[tokio::test]
async fn set_transcript_display_is_idempotent_and_never_affects_the_other_field() {
    let mut store = open_scratch_store(None).await;
    store
        .set_transcript_display("toolCalls", false)
        .await
        .unwrap();
    let result = store
        .set_transcript_display("toolCalls", false)
        .await
        .unwrap();
    assert!(result.transcript_display.thinking);
    assert!(!result.transcript_display.tool_calls);
}

#[tokio::test]
async fn set_transcript_display_persists_across_a_reopen() {
    let dir = crate::test_scratch::path(format!("refract-settings-test-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&dir).await.unwrap();
    let mut first = SettingsStore::open(&dir).await.unwrap();
    first
        .set_transcript_display("thinking", false)
        .await
        .unwrap();
    let reopened = SettingsStore::open(&dir).await.unwrap();
    assert!(!reopened.get().transcript_display.thinking);
    assert!(reopened.get().transcript_display.tool_calls);
}

/// Unknown keys round-trip untouched so renderer features can add fields later (#791).
#[tokio::test]
async fn unknown_keys_round_trip_untouched_across_an_unrelated_setter_and_a_reopen() {
    let dir = crate::test_scratch::path(format!("refract-settings-test-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&dir).await.unwrap();
    tokio::fs::write(
        dir.join("settings.json"),
        serde_json::to_vec(&json!({
            "version": 1, "approvalMode": "ask", "sessionReadout": {}, "split": null,
            "theme": "dark", "watermarkEnabled": true, "aFutureFeature": { "enabled": true }
        }))
        .unwrap(),
    )
    .await
    .unwrap();
    let mut store = SettingsStore::open(&dir).await.unwrap();
    store.set_show_sample_data(true).await.unwrap();

    let on_disk: Value =
        serde_json::from_slice(&tokio::fs::read(dir.join("settings.json")).await.unwrap()).unwrap();
    assert_eq!(
        on_disk.get("aFutureFeature"),
        Some(&json!({ "enabled": true }))
    );
    // Known fields are still written correctly alongside the unknown key.
    assert_eq!(on_disk.get("showSampleData"), Some(&json!(true)));
    assert_eq!(on_disk.get("approvalMode"), Some(&json!("ask")));

    // The wire shape (`serde_json::to_value`) must also carry the unknown key, via
    // `#[serde(flatten)]` on `Settings::extra`.
    let wire = serde_json::to_value(store.get()).unwrap();
    assert_eq!(
        wire.get("aFutureFeature"),
        Some(&json!({ "enabled": true }))
    );

    let reopened = SettingsStore::open(&dir).await.unwrap();
    assert!(reopened.get().show_sample_data);
}

#[tokio::test]
async fn set_approval_mode_persists_across_a_reopen() {
    let dir = crate::test_scratch::path(format!("refract-settings-test-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&dir).await.unwrap();
    let mut store = SettingsStore::open(&dir).await.unwrap();
    let next = store.set_approval_mode(ApprovalMode::Auto).await.unwrap();
    assert_eq!(next.approval_mode, ApprovalMode::Auto);
    let reopened = SettingsStore::open(&dir).await.unwrap();
    assert_eq!(reopened.get().approval_mode, ApprovalMode::Auto);
}

#[tokio::test]
async fn set_readout_visibility_persists_across_a_reopen() {
    let dir = crate::test_scratch::path(format!("refract-settings-test-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&dir).await.unwrap();
    let mut store = SettingsStore::open(&dir).await.unwrap();
    let next = store
        .set_readout_visibility("subagents", false)
        .await
        .unwrap();
    assert!(!next.session_readout.subagents);
    let reopened = SettingsStore::open(&dir).await.unwrap();
    assert!(!reopened.get().session_readout.subagents);
}

#[tokio::test]
async fn set_split_persists_across_a_reopen() {
    let dir = crate::test_scratch::path(format!("refract-settings-test-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&dir).await.unwrap();
    let mut store = SettingsStore::open(&dir).await.unwrap();
    let layout = SplitLayout {
        session_ids: ["a".to_string(), "b".to_string()],
        divider_percent: 60.0,
        focused_index: 1,
    };
    let next = store.set_split(Some(layout)).await.unwrap();
    assert!(next.split.is_some());
    let reopened = SettingsStore::open(&dir).await.unwrap();
    let persisted = reopened.get().split.unwrap();
    assert_eq!(persisted.session_ids, ["a".to_string(), "b".to_string()]);
    assert_eq!(persisted.divider_percent, 60.0);
    assert_eq!(persisted.focused_index, 1);
}

#[tokio::test]
async fn set_watermark_enabled_persists_across_a_reopen() {
    let dir = crate::test_scratch::path(format!("refract-settings-test-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&dir).await.unwrap();
    let mut store = SettingsStore::open(&dir).await.unwrap();
    let next = store.set_watermark_enabled(false).await.unwrap();
    assert!(!next.watermark_enabled);
    let reopened = SettingsStore::open(&dir).await.unwrap();
    assert!(!reopened.get().watermark_enabled);
}

#[tokio::test]
async fn set_detect_image_paths_on_paste_persists_across_a_reopen() {
    let dir = crate::test_scratch::path(format!("refract-settings-test-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&dir).await.unwrap();
    let mut store = SettingsStore::open(&dir).await.unwrap();
    let next = store.set_detect_image_paths_on_paste(false).await.unwrap();
    assert!(!next.detect_image_paths_on_paste);
    let reopened = SettingsStore::open(&dir).await.unwrap();
    assert!(!reopened.get().detect_image_paths_on_paste);
}
