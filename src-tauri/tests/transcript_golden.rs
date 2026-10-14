// Issue #795 (lane R12b, part 3; expanded under gate-remediation MEDIUM #11): golden tests
// proving `TranscriptState::from_history`/`apply_frame`/`upsert_item` here produce the SAME
// `TranscriptItem[]` JSON a real TS `fromHistory`/`applyFrame`/`upsertTranscriptItem` run once
// produced (TS's own reader, `src/main/omp/transcript.golden.test.ts`, was deleted during gate
// remediation per AGENTS.md's "no new tests" rule -- this file is now the sole reader of every
// fixture pair under scripts/fixtures/transcript-golden/; see that directory's README for
// per-scenario provenance and the `startedAt`/`durationMs` normalization every test applies).

use std::fs;
use std::path::{Path, PathBuf};

use refract_tauri_lib::omp::transcript::{TranscriptItem, TranscriptState};
use serde_json::Value;

fn fixture_path(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("scripts/fixtures/transcript-golden")
        .join(name)
}

fn read_json(name: &str) -> Value {
    let raw = fs::read_to_string(fixture_path(name)).unwrap_or_else(|e| panic!("read {name}: {e}"));
    serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse {name}: {e}"))
}

// Wall-clock fields are never reproducible across runs/languages; see the fixture README's
// "Wall-clock fields are normalized, not golden" section. Identical walk in
// transcript.golden.test.ts's own `normalizeTiming`.
fn normalize_timing(value: Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.into_iter().map(normalize_timing).collect()),
        Value::Object(map) => {
            let mut out = serde_json::Map::with_capacity(map.len());
            for (key, v) in map {
                let normalized = if key == "startedAt" || key == "durationMs" {
                    Value::from(0)
                } else {
                    normalize_timing(v)
                };
                out.insert(key, normalized);
            }
            Value::Object(out)
        }
        other => other,
    }
}

#[test]
fn from_history_matches_history_golden_json() {
    let messages = match read_json("history-scenario.json") {
        Value::Array(messages) => messages,
        other => panic!("history-scenario.json must be a JSON array, got {other:?}"),
    };
    let golden = read_json("history-golden.json");

    let state = TranscriptState::from_history(&messages);
    let items = serde_json::to_value(state.items()).expect("serialize history items");

    assert_eq!(normalize_timing(items), golden);
}

#[test]
fn apply_frame_folded_over_live_frames_scenario_matches_live_frames_golden_json() {
    let frames = match read_json("live-frames-scenario.json") {
        Value::Array(frames) => frames,
        other => panic!("live-frames-scenario.json must be a JSON array, got {other:?}"),
    };
    let golden = read_json("live-frames-golden.json");

    let mut state = TranscriptState::new();
    for frame in &frames {
        state.apply_frame(frame);
    }
    let items = serde_json::to_value(state.items()).expect("serialize live-frames items");

    assert_eq!(normalize_timing(items), golden);
}

// ---------------------------------------------------------------------------
// Gate-remediation MEDIUM #11: per-scenario coverage of code paths the two round-trip tests
// above don't individually isolate (`thinking`, `isError`, `subagent`, `notice`,
// `hasUserActed: true`, reset-on-removal, `request`). See the fixture README's "Files" table.
// ---------------------------------------------------------------------------

#[test]
fn from_history_matches_thinking_golden_json() {
    let messages = match read_json("thinking-scenario.json") {
        Value::Array(messages) => messages,
        other => panic!("thinking-scenario.json must be a JSON array, got {other:?}"),
    };
    let golden = read_json("thinking-golden.json");

    let state = TranscriptState::from_history(&messages);
    let items = serde_json::to_value(state.items()).expect("serialize thinking items");

    assert_eq!(normalize_timing(items), golden);
}

#[test]
fn from_history_matches_is_error_golden_json() {
    let messages = match read_json("isError-scenario.json") {
        Value::Array(messages) => messages,
        other => panic!("isError-scenario.json must be a JSON array, got {other:?}"),
    };
    let golden = read_json("isError-golden.json");

    let state = TranscriptState::from_history(&messages);
    let items = serde_json::to_value(state.items()).expect("serialize isError items");

    assert_eq!(normalize_timing(items), golden);
}

#[test]
fn apply_frame_matches_subagent_golden_json() {
    let frames = match read_json("subagent-scenario.json") {
        Value::Array(frames) => frames,
        other => panic!("subagent-scenario.json must be a JSON array, got {other:?}"),
    };
    let golden = read_json("subagent-golden.json");

    let mut state = TranscriptState::new();
    for frame in &frames {
        state.apply_frame(frame);
    }
    let items = serde_json::to_value(state.items()).expect("serialize subagent items");

    assert_eq!(normalize_timing(items), golden);
}

#[test]
fn apply_frame_matches_notice_golden_json() {
    let frames = match read_json("notice-scenario.json") {
        Value::Array(frames) => frames,
        other => panic!("notice-scenario.json must be a JSON array, got {other:?}"),
    };
    let golden = read_json("notice-golden.json");

    // `hasUserActed: false` (the default), matching `TranscriptState::new()`.
    let mut state = TranscriptState::new();
    for frame in &frames {
        state.apply_frame(frame);
    }
    let items = serde_json::to_value(state.items()).expect("serialize notice items");

    assert_eq!(normalize_timing(items), golden);
}

#[test]
fn apply_frame_matches_has_user_acted_golden_json() {
    let frames = match read_json("hasUserActed-scenario.json") {
        Value::Array(frames) => frames,
        other => panic!("hasUserActed-scenario.json must be a JSON array, got {other:?}"),
    };
    let golden = read_json("hasUserActed-golden.json");

    let mut state = TranscriptState::new();
    state.mark_user_acted();
    for frame in &frames {
        state.apply_frame(frame);
    }
    let items = serde_json::to_value(state.items()).expect("serialize hasUserActed items");

    assert_eq!(normalize_timing(items), golden);
}

#[test]
fn apply_frame_matches_reset_on_removal_golden_json() {
    let frames = match read_json("reset-on-removal-scenario.json") {
        Value::Array(frames) => frames,
        other => panic!("reset-on-removal-scenario.json must be a JSON array, got {other:?}"),
    };
    let golden = read_json("reset-on-removal-golden.json");

    let mut state = TranscriptState::new();
    for frame in &frames {
        state.apply_frame(frame);
    }
    let items = serde_json::to_value(state.items()).expect("serialize reset-on-removal items");

    assert_eq!(normalize_timing(items), golden);
}

/// `kind: 'request'` items are never built by `fromHistory`/`applyFrame` (confirmed against both
/// function bodies) -- they are upserted directly by `SessionAgent.ts`'s private
/// `upsertTranscriptItem`, ported here as `TranscriptState::upsert_item`. This fixture is a plain
/// `TranscriptItem[]` sequence, not an `OmpMessage[]`/`Frame[]`; see the README's `request`
/// provenance note.
#[test]
fn upsert_item_sequence_matches_request_golden_json() {
    let scenario_items = match read_json("request-scenario.json") {
        Value::Array(items) => items,
        other => panic!("request-scenario.json must be a JSON array, got {other:?}"),
    };
    let golden = read_json("request-golden.json");

    let mut state = TranscriptState::new();
    for raw_item in scenario_items {
        let item: TranscriptItem =
            serde_json::from_value(raw_item).expect("deserialize request-scenario.json item");
        state.upsert_item(item);
    }
    let items = serde_json::to_value(state.items()).expect("serialize request items");

    assert_eq!(normalize_timing(items), golden);
}
