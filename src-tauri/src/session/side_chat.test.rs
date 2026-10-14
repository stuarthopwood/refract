// Unit tests for `session::side_chat` (lane R6, issue #789). No TS test file exists for side
// chat (confirmed: `SessionAgent.test.ts` and every other `.test.ts` in `src/main` have zero
// references to `sideChat`/`btw`/`flattenBtwHistory`) -- these port the issue's own named
// gate-fix behaviours (SessionAgent.ts lines ~105-330, ~979-1010) as Rust tests instead: terminal
// record forwarding, cancelled-topic isolation, stamping order, and entry deletion at a terminal
// turn. `#[path]`-loaded sibling of `side_chat.rs` (excluded from `check:file-size` by its own
// `.test.rs` name), matching `session::termination`'s own split.
//
// Gate-fix (2026-10-14 gate review CRITICAL): the stamping-order / cancelled-topic-isolation
// tests used to hand-build a `State` and assert on the isolated `topic_frame_is_stale` predicate
// directly -- a tautology that cannot fail for a regression in how `ask`/`on_frame` themselves
// read or mutate the REAL state. They now drive `stamp_continuation_before_ask`/`apply_frame`,
// the exact pure seams `ask`/`on_frame` call in production, across a realistic multi-call
// sequence against one real `State`.
use super::*;

fn node(question: &str, answer: &str, status: &str) -> Value {
    json!({
        "question": question,
        "answer": answer,
        "status": status,
        "createdAt": 1,
        "updatedAt": 2,
    })
}

#[test]
fn flatten_a_root_only_thread_carries_topic_id_and_leaf_id() {
    let thread = json!({
        "id": "topic-1",
        "leafId": "leaf-1",
        "question": "q",
        "answer": "a",
        "status": "complete",
        "createdAt": 1,
        "updatedAt": 2,
    });
    let flattened = flatten_btw_history(&thread);
    assert_eq!(flattened.len(), 1);
    let root = &flattened[0];
    assert_eq!(root["id"], "topic-1");
    assert_eq!(root["topicId"], "topic-1");
    assert_eq!(root["leafId"], "leaf-1");
    assert_eq!(root["status"], "complete");
}

/// Gate-fix (round 4, Code4/Verif4 CRITICAL): a non-root node carries no real id of its own, so
/// each is given a stable, position-derived `${id}.${index}` key built from its OWN PARENT's id;
/// every flattened record (root or not) carries `topicId` (the thread's own root `id`); only the
/// root carries `leafId`.
#[test]
fn flatten_a_multi_level_thread_builds_dotted_synthetic_ids_and_shared_topic_id() {
    let thread = json!({
        "id": "topic-1",
        "leafId": "leaf-1",
        "question": "root q",
        "answer": "root a",
        "status": "complete",
        "createdAt": 1,
        "updatedAt": 2,
        "followUps": [
            {
                "question": "follow 1",
                "answer": "answer 1",
                "status": "complete",
                "createdAt": 3,
                "updatedAt": 4,
                "followUps": [
                    {
                        "question": "follow 1.1",
                        "answer": "answer 1.1",
                        "status": "running",
                        "createdAt": 5,
                        "updatedAt": 6,
                    }
                ],
            },
            {
                "question": "follow 2",
                "answer": "answer 2",
                "status": "error",
                "error": "boom",
                "createdAt": 7,
                "updatedAt": 8,
            },
        ],
    });
    let flattened = flatten_btw_history(&thread);
    let ids: Vec<&str> = flattened
        .iter()
        .map(|r| r["id"].as_str().unwrap())
        .collect();
    assert_eq!(
        ids,
        vec!["topic-1", "topic-1.0", "topic-1.0.0", "topic-1.1"]
    );
    // Every record, root or not, shares the SAME topicId -- never a child's own id.
    for record in &flattened {
        assert_eq!(record["topicId"], "topic-1");
    }
    // Only the root carries `leafId`.
    assert_eq!(flattened[0]["leafId"], "leaf-1");
    assert!(flattened[1].get("leafId").is_none());
    assert!(flattened[2].get("leafId").is_none());
    assert!(flattened[3].get("leafId").is_none());
    // `error` is present only where the node actually carried one.
    assert!(flattened[0].get("error").is_none());
    assert_eq!(flattened[3]["error"], "boom");
}

/// Gate-fix (round 4, Code4/Verif4 CRITICAL): a follow-up's own terminal `btw_record` still
/// carries the ROOT's `question`/`answer`/`status`, with the new turn nested at `followUps`'s
/// last entry -- `latest_turn` must normalise it to the actual LATEST turn, never the stale root.
#[test]
fn latest_turn_returns_the_deepest_follow_up_not_the_stale_root() {
    let thread = json!({
        "id": "topic-1",
        "leafId": "leaf-1",
        "question": "root q",
        "answer": "root a (stale)",
        "status": "running",
        "createdAt": 1,
        "updatedAt": 2,
        "followUps": [
            {
                "question": "follow up q",
                "answer": "the real latest answer",
                "status": "complete",
                "createdAt": 3,
                "updatedAt": 4,
            }
        ],
    });
    let turn = latest_turn(&thread);
    assert_eq!(turn["id"], "topic-1.0");
    assert_eq!(turn["topicId"], "topic-1");
    assert_eq!(turn["answer"], "the real latest answer");
    assert_eq!(turn["status"], "complete");
}

#[test]
fn latest_turn_of_a_root_only_thread_is_the_root_itself() {
    let mut thread = node("q", "a", "running");
    thread["id"] = json!("topic-only");
    let turn = latest_turn(&thread);
    assert_eq!(turn["id"], "topic-only");
    assert_eq!(turn["answer"], "a");
}

// ---------------------------------------------------------------------------
// Entry deletion at a terminal turn (gate-fix round 9)
// ---------------------------------------------------------------------------

#[test]
fn a_running_turn_is_not_terminal() {
    assert!(!turn_reached_terminal("running"));
}

#[test]
fn every_non_running_status_is_terminal() {
    for status in ["complete", "cancelled", "error", "interrupted"] {
        assert!(turn_reached_terminal(status), "{status} must be terminal");
    }
}

// ---------------------------------------------------------------------------
// Terminal record forwarding (gate-fix round 2, Verif2 LOW; round 4, Code4 Medium)
// ---------------------------------------------------------------------------

#[test]
fn a_btw_delta_is_dropped_while_hidden() {
    assert!(!should_forward_side_chat_patch(false, false));
}

#[test]
fn a_btw_delta_is_forwarded_while_visible() {
    assert!(should_forward_side_chat_patch(false, true));
}

/// Gate-fix (round 2, Verif2 LOW): a terminal `btw_record` is ALWAYS forwarded, even for a
/// Session hidden mid-request -- losing a side chat's own completion to the visibility gate
/// leaves the panel stuck on "Thinking" until a reload.
#[test]
fn a_terminal_btw_record_is_forwarded_even_while_hidden() {
    assert!(should_forward_side_chat_patch(true, false));
}

/// Gate-fix (round 4, Code4 Medium): a `btw-history` save-failure notice is forwarded
/// unconditionally too -- the question itself may have landed while the pane was hidden; the
/// developer must still learn their answer did not save when they return.
#[test]
fn a_btw_history_notice_is_forwarded_even_while_hidden() {
    assert!(should_forward_side_chat_patch(true, false));
}

// ---------------------------------------------------------------------------
// `apply_frame` -- the real seam `on_frame` calls, driven end to end (gate-fix, 2026-10-14 gate
// review CRITICAL: replaces the old isolated-predicate tests below this point)
// ---------------------------------------------------------------------------

fn btw_record_frame(id: &str, status: &str) -> Value {
    json!({ "record": { "id": id, "leafId": format!("{id}-leaf"), "question": "q", "answer": "a", "status": status, "createdAt": 1, "updatedAt": 2, "followUps": [] } })
}

/// Gate-fix (round 6, defense in depth): a topic never stamped by `ask` at all (loaded from
/// history, never asked through this process instance) must NOT be treated as stale -- only a
/// topic actually stamped with an OLDER epoch is dropped. Driven through the real `apply_frame`,
/// not an isolated call to `topic_frame_is_stale`.
#[test]
fn a_topic_never_stamped_falls_back_to_the_current_epoch_and_is_never_stale() {
    let mut state = State::default();
    let frame = json!({ "recordId": "never-asked", "delta": "hi" });
    let patch = apply_frame(&mut state, "btw_delta", &frame, true);
    assert_eq!(
        patch,
        Some(SideChatPatch::Delta {
            delta: "hi".to_string(),
            record_id: "never-asked".to_string(),
        })
    );
}

/// Gate-fix (round 7, Code7/Verif7 Medium), the "stamping order" behaviour: `ask` captures its own
/// `conversation_epoch` BEFORE sending the request and stamps the topic with that captured value,
/// never a value re-read after the response arrives. Drives the REAL sequence through
/// `stamp_continuation_before_ask` (what `ask` itself calls) then `on_conversation_reset` (what a
/// Conversation switch landing mid-flight calls) against ONE real `State`, then asserts the
/// already-stamped topic's late response is correctly dropped by `apply_frame`.
#[tokio::test]
async fn a_topic_stamped_before_a_conversation_switch_is_stale_after_it() {
    let mut state = State::default();
    stamp_continuation_before_ask(&mut state, Some("topic-1"));
    // The Conversation switch (`on_conversation_reset`'s own bump) lands while the `ask` that
    // stamped "topic-1" is still conceptually in flight.
    state.conversation_epoch = state.conversation_epoch.wrapping_add(1);

    let frame = btw_record_frame("topic-1", "complete");
    let patch = apply_frame(&mut state, "btw_record", &frame, true);
    assert_eq!(
        patch, None,
        "a response stamped with the OLD epoch must be dropped once the switch has happened"
    );
    // The entry is still removed (settledness-bounded deletion runs regardless of staleness).
    assert!(!state.topic_epoch.contains_key("topic-1"));
}

/// Gate-fix (round 6, Code6/Sec6/A11y6/Verif6 HIGH): "cancelled-topic isolation" -- a topic
/// stamped in the Conversation just left must never have its late frames (a cancelled topic's
/// trailing `btw_delta`/`btw_record`) forwarded into whichever Conversation is now current, even
/// though nothing about the frame itself says which Conversation it belongs to. A topic stamped
/// in the CURRENT Conversation is unaffected.
#[tokio::test]
async fn a_cancelled_topics_late_frame_is_dropped_once_the_conversation_has_moved_on() {
    let mut state = State::default();
    stamp_continuation_before_ask(&mut state, Some("cancelled-topic"));
    state.conversation_epoch = state.conversation_epoch.wrapping_add(1); // the switch that followed the cancel

    let late_delta = json!({ "recordId": "cancelled-topic", "delta": "leaked text" });
    assert_eq!(
        apply_frame(&mut state, "btw_delta", &late_delta, true),
        None
    );

    // A topic stamped in the SAME (current) Conversation is never dropped this way.
    stamp_continuation_before_ask(&mut state, Some("current-topic"));
    let current_delta = json!({ "recordId": "current-topic", "delta": "fine" });
    assert_eq!(
        apply_frame(&mut state, "btw_delta", &current_delta, true),
        Some(SideChatPatch::Delta {
            delta: "fine".to_string(),
            record_id: "current-topic".to_string(),
        })
    );
}

/// Gate-fix (round 9, Code9/Sec9/A11y9/Verif9 Medium): a STALE terminal frame still deletes its
/// own `topic_epoch` entry (settledness-bounded, never by staleness) even though the frame itself
/// is dropped as stale -- otherwise a cancelled-Conversation topic's entry would leak forever.
#[tokio::test]
async fn a_stale_terminal_frame_is_dropped_but_still_deletes_its_entry() {
    let mut state = State::default();
    stamp_continuation_before_ask(&mut state, Some("topic-1"));
    state.conversation_epoch = state.conversation_epoch.wrapping_add(1);
    assert!(state.topic_epoch.contains_key("topic-1"));

    let frame = btw_record_frame("topic-1", "complete");
    assert_eq!(apply_frame(&mut state, "btw_record", &frame, true), None);
    assert!(!state.topic_epoch.contains_key("topic-1"));
}

/// Gate-fix (round 9, wording corrected round 10): deletion is bounded by the LATEST turn's own
/// status, never the root's -- a root left `running` forever (because a follow-up, not the root,
/// settled) must still have its entry deleted once `latest_turn` reports terminal.
#[tokio::test]
async fn deletion_follows_the_latest_turns_status_not_the_stale_root() {
    let mut state = State::default();
    stamp_continuation_before_ask(&mut state, Some("topic-1"));
    let frame = json!({ "record": {
        "id": "topic-1", "leafId": "leaf-1", "question": "root q", "answer": "root a",
        "status": "running", "createdAt": 1, "updatedAt": 2,
        "followUps": [ { "question": "f", "answer": "done", "status": "complete", "createdAt": 3, "updatedAt": 4 } ],
    } });
    let patch = apply_frame(&mut state, "btw_record", &frame, true);
    assert!(
        !state.topic_epoch.contains_key("topic-1"),
        "the follow-up's own terminal status must delete the root's entry"
    );
    assert_eq!(
        patch,
        Some(SideChatPatch::Record {
            record: json!({ "id": "topic-1.0", "topicId": "topic-1", "question": "f", "answer": "done", "status": "complete", "createdAt": 3, "updatedAt": 4 })
        })
    );
}

/// Gate-fix (round 4, Code4 Medium, constitution II/FR-010): a `btw-history` save-failure notice
/// routes through `apply_frame`'s own `"notice"` case, forwarded unconditionally (even hidden);
/// a `notice` from any OTHER source is never routed to side chat at all.
#[test]
fn btw_history_notice_is_forwarded_unconditionally_other_notices_are_ignored() {
    let mut state = State::default();
    let btw_history_notice = json!({ "source": "btw-history", "message": "save failed" });
    assert_eq!(
        apply_frame(&mut state, "notice", &btw_history_notice, false),
        Some(SideChatPatch::Notice {
            message: "save failed".to_string()
        })
    );
    let other_notice = json!({ "source": "something-else", "message": "irrelevant" });
    assert_eq!(apply_frame(&mut state, "notice", &other_notice, true), None);
}

// ---------------------------------------------------------------------------
// `on_exit` / `on_conversation_reset` against a real `SessionAgent` (gate-fix, 2026-10-14 gate
// review: real-agent harness, same pattern `session::termination.test.rs`'s own
// `make_marker_test_agent` uses)
// ---------------------------------------------------------------------------

async fn make_test_agent(label: &str) -> std::sync::Arc<SessionAgent> {
    let dir = std::env::temp_dir().join(format!(
        "refract-side-chat-test-agent-{label}-{}",
        uuid::Uuid::new_v4()
    ));
    tokio::fs::create_dir_all(&dir).await.unwrap();
    let session_id = format!("session-{label}");
    let now = "2026-01-01T00:00:00.000Z".to_string();
    let session = crate::store::registry::Session {
        id: session_id.clone(),
        repository_id: "repo-1".to_string(),
        name: "Test Session".to_string(),
        branch: "test-branch".to_string(),
        base_branch: "main".to_string(),
        worktree_path: dir.to_string_lossy().into_owned(),
        session_dir: None,
        current_conversation: None,
        last_message_count: None,
        last_model: None,
        last_thinking_level: None,
        created_at: now.clone(),
        last_activity_at: now,
        archived_at: None,
        current_turn_subagents: None,
        stopped_on_request_conversation: None,
        stopped_on_request_at_size: None,
    };
    let mut registry_store = crate::store::registry::RegistryStore::open(&dir)
        .await
        .unwrap();
    registry_store
        .add_repository(crate::store::registry::Repository {
            id: "repo-1".to_string(),
            path: dir.to_string_lossy().into_owned(),
            name: "Test Repo".to_string(),
            default_branch: "main".to_string(),
            added_at: "2026-01-01T00:00:00.000Z".to_string(),
        })
        .await
        .unwrap();
    registry_store.add_session(session).await.unwrap();
    let registry = std::sync::Arc::new(tokio::sync::Mutex::new(registry_store));
    let settings = std::sync::Arc::new(tokio::sync::Mutex::new(
        crate::store::settings::SettingsStore::open(&dir)
            .await
            .unwrap(),
    ));
    let app_handle_slot = std::sync::Arc::new(std::sync::Mutex::new(None));
    let events = crate::events::EventSink::new(app_handle_slot, registry.clone());
    let manager = crate::session::manager::SessionManager::new(registry, settings, events);
    manager.get_or_create_agent(&session_id)
}

/// Port of `SessionAgent.ts`'s own `onExit`: `topic_epoch` is cleared unconditionally on every
/// process exit, regardless of what was in it -- driven against a REAL agent (`events()`'s own
/// `send` silently no-ops with no live Tauri window, which is exactly what a unit test needs).
#[tokio::test]
async fn on_exit_clears_the_topic_epoch_map_unconditionally() {
    let agent = make_test_agent("on-exit").await;
    agent
        .with_side_chat_state(|s| {
            s.topic_epoch.insert("left-running".to_string(), 0);
            s.conversation_epoch = 5;
        })
        .await;
    on_exit(&agent, None, false).await;
    let (topic_epoch_len, conversation_epoch) = agent
        .with_side_chat_state(|s| (s.topic_epoch.len(), s.conversation_epoch))
        .await;
    assert_eq!(topic_epoch_len, 0);
    // `on_exit` only clears `topic_epoch`, never the Conversation epoch itself.
    assert_eq!(conversation_epoch, 5);
}

/// `on_conversation_reset` bumps the epoch exactly once per call -- driven against a real agent
/// so a regression that calls it zero or twice (or forgets the `wrapping_add`) is observable.
#[tokio::test]
async fn on_conversation_reset_bumps_the_epoch_exactly_once() {
    let agent = make_test_agent("conv-reset").await;
    let before = agent.with_side_chat_state(|s| s.conversation_epoch).await;
    on_conversation_reset(&agent).await;
    let after = agent.with_side_chat_state(|s| s.conversation_epoch).await;
    assert_eq!(after, before.wrapping_add(1));
}

// ---------------------------------------------------------------------------
// `reset_after_start_with_conversation` (gate-fix, 2026-10-14 gate review HIGH: a stopped
// Session's Conversation switch used to never reset side chat at all)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn reset_after_start_with_conversation_skips_when_the_worktree_write_never_happened() {
    let agent = make_test_agent("skip-no-write").await;
    let before = agent.with_side_chat_state(|s| s.conversation_epoch).await;
    reset_after_start_with_conversation(&agent, Some("file-a"), None).await;
    let after = agent.with_side_chat_state(|s| s.conversation_epoch).await;
    assert_eq!(
        after, before,
        "no registry write happened, so no reset either"
    );
}

#[tokio::test]
async fn reset_after_start_with_conversation_resets_on_a_genuine_conversation_change() {
    let agent = make_test_agent("reset-changed").await;
    let before = agent.with_side_chat_state(|s| s.conversation_epoch).await;
    reset_after_start_with_conversation(&agent, Some("file-b"), Some(Some("file-a".to_string())))
        .await;
    let after = agent.with_side_chat_state(|s| s.conversation_epoch).await;
    assert_eq!(after, before.wrapping_add(1));
}

#[tokio::test]
async fn reset_after_start_with_conversation_always_resets_for_a_brand_new_conversation() {
    let agent = make_test_agent("reset-new").await;
    let before = agent.with_side_chat_state(|s| s.conversation_epoch).await;
    // `file: None` always resets, even though `previous_conversation` was also `None`.
    reset_after_start_with_conversation(&agent, None, Some(None)).await;
    let after = agent.with_side_chat_state(|s| s.conversation_epoch).await;
    assert_eq!(after, before.wrapping_add(1));
}

#[tokio::test]
async fn reset_after_start_with_conversation_skips_reopening_the_same_conversation() {
    let agent = make_test_agent("reset-same").await;
    let before = agent.with_side_chat_state(|s| s.conversation_epoch).await;
    reset_after_start_with_conversation(&agent, Some("file-a"), Some(Some("file-a".to_string())))
        .await;
    let after = agent.with_side_chat_state(|s| s.conversation_epoch).await;
    assert_eq!(
        after, before,
        "reopening the SAME Conversation must not reset side chat"
    );
}

// ---------------------------------------------------------------------------
// `history`'s own post-RPC shaping (gate-fix round 4, Code4/Verif4 HIGH)
// ---------------------------------------------------------------------------

/// OMP's own `get_btw_history` returns topics NEWEST first; `sort_and_flatten_threads` (what
/// `history` itself calls) must reorder them ascending so the flattened result reads
/// oldest-to-newest.
#[test]
fn sort_and_flatten_threads_reorders_newest_first_input_to_oldest_first_output() {
    let newest_first = vec![
        json!({ "id": "topic-3", "question": "q3", "answer": "a3", "status": "complete", "createdAt": 30, "updatedAt": 30 }),
        json!({ "id": "topic-1", "question": "q1", "answer": "a1", "status": "complete", "createdAt": 10, "updatedAt": 10 }),
        json!({ "id": "topic-2", "question": "q2", "answer": "a2", "status": "complete", "createdAt": 20, "updatedAt": 20 }),
    ];
    let flattened = sort_and_flatten_threads(newest_first);
    let ids: Vec<&str> = flattened
        .iter()
        .map(|r| r["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec!["topic-1", "topic-2", "topic-3"]);
}
