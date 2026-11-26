// The transcript only reads a label source: it labels by `toolCallId` and spec index, omits both fields
// when nothing is known, and a replayed history reads the cache without ever asking for a synthesis.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use super::super::{TranscriptItem, TranscriptState};
use super::{labelled_copy, SubagentLabels, SynthesisLookup};

/// The overall goal and the per-spec roles of one `task()` call.
type Entry = (Option<String>, Vec<Option<String>>);

/// A label source that counts its reads; it has no write path, which is the contract under test.
#[derive(Default)]
struct FakeLookup {
    entries: Mutex<HashMap<String, Entry>>,
    reads: AtomicUsize,
}

impl FakeLookup {
    fn with(tool_call_id: &str, goal: &str, roles: &[Option<&str>]) -> Arc<Self> {
        let lookup = Self::default();
        lookup.put(tool_call_id, goal, roles);
        Arc::new(lookup)
    }

    fn put(&self, tool_call_id: &str, goal: &str, roles: &[Option<&str>]) {
        let roles = roles.iter().map(|r| r.map(str::to_string)).collect();
        self.entries
            .lock()
            .unwrap()
            .insert(tool_call_id.to_string(), (Some(goal.to_string()), roles));
    }
}

impl SynthesisLookup for FakeLookup {
    fn labels(&self, tool_call_id: &str, spec_index: u32) -> SubagentLabels {
        self.reads.fetch_add(1, Ordering::Relaxed);
        self.entries
            .lock()
            .unwrap()
            .get(tool_call_id)
            .map(|(goal, roles)| SubagentLabels {
                role: roles.get(spec_index as usize).cloned().flatten(),
                overall_goal: goal.clone(),
            })
            .unwrap_or_default()
    }
}

fn task_start() -> Value {
    json!({
        "type": "tool_execution_start", "toolCallId": "call-1", "toolName": "task",
        "args": { "tasks": [{ "name": "ImplA", "task": "do a" }, { "name": "ImplB", "task": "do b" }] }
    })
}

fn history() -> Vec<Value> {
    vec![
        json!({ "role": "assistant", "content": [{
            "type": "toolCall", "id": "call-1", "name": "task",
            "arguments": { "tasks": [{ "name": "ImplA", "task": "do a" }, { "name": "ImplB", "task": "do b" }] }
        }] }),
        json!({ "role": "toolResult", "toolCallId": "call-1", "toolName": "task",
            "isError": false, "content": [],
            "details": { "progress": [{ "id": "job-0", "status": "done" }, { "id": "job-1", "status": "done" }] } }),
    ]
}

/// The serialised `subagent` rows, so the wire shape is what is asserted.
fn rows(state: &TranscriptState) -> Vec<Value> {
    state
        .items()
        .iter()
        .filter(|item| matches!(item.as_ref(), TranscriptItem::Subagent { .. }))
        .map(|item| serde_json::to_value(item.as_ref()).unwrap())
        .collect()
}

#[test]
fn a_live_row_is_labelled_by_tool_call_id_and_spec_index() {
    let mut state = TranscriptState::new();
    state.set_synthesis_lookup(FakeLookup::with(
        "call-1",
        "Ship the flag",
        &[Some("Builder"), None],
    ));
    state.apply_frame(&task_start(), false);

    let rows = rows(&state);
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["role"], "Builder");
    assert_eq!(rows[0]["overallGoal"], "Ship the flag");
    assert!(rows[1].get("role").is_none());
    assert_eq!(rows[1]["overallGoal"], "Ship the flag");
}

#[test]
fn an_absent_entry_omits_both_fields_from_the_json() {
    let mut state = TranscriptState::new();
    state.set_synthesis_lookup(FakeLookup::with("other-call", "Elsewhere", &[Some("X")]));
    state.apply_frame(&task_start(), false);

    for row in rows(&state) {
        assert!(row.get("role").is_none(), "{row}");
        assert!(row.get("overallGoal").is_none(), "{row}");
    }
}

#[test]
fn a_state_with_no_lookup_omits_both_fields_from_the_json() {
    let mut state = TranscriptState::new();
    state.apply_frame(&task_start(), false);

    assert_eq!(rows(&state).len(), 2);
    for row in rows(&state) {
        assert!(row.get("role").is_none(), "{row}");
        assert!(row.get("overallGoal").is_none(), "{row}");
    }
    assert!(!state.relabel_subagents());
}

#[test]
fn a_synthesis_that_lands_after_the_row_labels_it_on_the_next_pass_once() {
    let lookup = Arc::new(FakeLookup::default());
    let mut state = TranscriptState::new();
    state.set_synthesis_lookup(lookup.clone());
    state.apply_frame(&task_start(), false);
    assert!(rows(&state)[0].get("role").is_none());

    lookup.put(
        "call-1",
        "Ship the flag",
        &[Some("Builder"), Some("Tester")],
    );
    assert!(state.relabel_subagents());
    let rows = rows(&state);
    assert_eq!(rows[0]["role"], "Builder");
    assert_eq!(rows[1]["role"], "Tester");

    // A labelled row is not read again, so streaming frames do not clone the strings.
    let reads = lookup.reads.load(Ordering::Relaxed);
    assert!(!state.relabel_subagents());
    assert_eq!(lookup.reads.load(Ordering::Relaxed), reads);
}

#[test]
fn history_replay_reads_the_cache_and_never_asks_for_a_synthesis() {
    let lookup = FakeLookup::with(
        "call-1",
        "Ship the flag",
        &[Some("Builder"), Some("Tester")],
    );
    let mut state = TranscriptState::from_history(&history());
    assert!(rows(&state)[0].get("role").is_none());

    assert!(state.set_synthesis_lookup(lookup.clone()));

    let rows = rows(&state);
    assert_eq!(rows[0]["role"], "Builder");
    assert_eq!(rows[1]["overallGoal"], "Ship the flag");
    // Two reads, one per row: the only thing the transcript did with the source was read it.
    assert_eq!(lookup.reads.load(Ordering::Relaxed), 2);
}

#[test]
fn a_replacement_transcript_keeps_the_label_source_and_labels_its_rows() {
    let mut state = TranscriptState::new();
    state.set_synthesis_lookup(FakeLookup::with(
        "call-1",
        "Ship the flag",
        &[Some("Builder")],
    ));

    state.replace_keeping_lookup(TranscriptState::from_history(&history()));

    assert_eq!(rows(&state)[0]["role"], "Builder");
    state.replace_keeping_lookup(TranscriptState::new());
    state.apply_frame(&task_start(), false);
    assert_eq!(rows(&state)[0]["role"], "Builder");
}

#[test]
fn a_labelled_copy_leaves_the_shared_history_unlabelled() {
    let shared = TranscriptState::from_history(&history()).items().to_vec();
    let lookup = FakeLookup::with("call-1", "Ship the flag", &[Some("Builder")]);

    let copy = labelled_copy(&shared, lookup.as_ref());

    let role = |items: &[Arc<TranscriptItem>]| {
        items.iter().find_map(|item| match item.as_ref() {
            TranscriptItem::Subagent { role, .. } => Some(role.clone()),
            _ => None,
        })
    };
    assert_eq!(role(&copy), Some(Some("Builder".to_string())));
    assert_eq!(role(&shared), Some(None));
}
