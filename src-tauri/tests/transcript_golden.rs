// Issue #795 (lane R12b, part 3): golden tests proving `TranscriptState::from_history`/
// `apply_frame` here and `fromHistory`/`applyFrame` in TypeScript
// (`src/main/omp/transcript.golden.test.ts`) produce byte-identical `TranscriptItem[]` JSON for
// the same input frames/history. Both readers read the SAME four fixture files under
// scripts/fixtures/transcript-golden/ (see that directory's README for provenance and the
// `startedAt`/`durationMs` normalization every reader applies).

use std::fs;
use std::path::{Path, PathBuf};

use refract_tauri_lib::omp::transcript::TranscriptState;
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
