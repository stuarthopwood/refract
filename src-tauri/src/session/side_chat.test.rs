// Unit tests for `session::side_chat` (lane R6, issue #789). No TS test file exists for side
// chat (confirmed: `SessionAgent.test.ts` and every other `.test.ts` in `src/main` have zero
// references to `sideChat`/`btw`/`flattenBtwHistory`) -- these port the issue's own named
// gate-fix behaviours (SessionAgent.ts lines ~105-330, ~979-1010) as Rust tests instead: terminal
// record forwarding, cancelled-topic isolation, stamping order, and entry deletion at a terminal
// turn. `#[path]`-loaded sibling of `side_chat.rs` (excluded from `check:file-size` by its own
// `.test.rs` name), matching `session::termination`'s own split.
//
// Gate-fix (2026-10-14 gate review round 1 CRITICAL): the stamping-order / cancelled-topic-
// isolation tests used to hand-build a `State` and assert on the isolated `topic_frame_is_stale`
// predicate directly -- a tautology that cannot fail for a regression in how `ask`/`on_frame`
// themselves read or mutate the REAL state. They now drive `apply_frame`/`stamp_continuation_
// before_ask`/`stamp_topic_after_response`/`on_conversation_reset`, the exact seams production
// code calls, across realistic multi-call sequences against one real `State` (or a real
// `SessionAgent`, same harness pattern `session::termination.test.rs`'s own
// `make_marker_test_agent` uses, when a test needs `on_conversation_reset`/`on_exit` for real).
//
// Gate-fix (round 2 CRITICAL/HIGH): a REAL cross-Conversation leak this round's own review found
// -- a cancelled topic's terminal record fully deleted its `topic_epoch` entry, so a late
// straggler frame for that SAME topic fell back to the CURRENT epoch (`unwrap_or`) once the
// active entry was gone, and was wrongly forwarded into the new Conversation. `apply_frame` now
// tombstones a terminal topic's epoch (`State::terminal_topic_epoch`) instead of forgetting it
// outright; `on_conversation_reset` retains only the current generation's tombstones so the map
// stays bounded. See `a_cancelled_topics_late_frames_are_dropped_even_after_a_conversation_switch`
// below -- it fails without that fix.
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
// `apply_frame` -- the real seam `on_frame` calls, driven end to end (gate-fix, 2026-10-14 gate
// review round 1 CRITICAL: replaces every isolated-predicate test below this point)
// ---------------------------------------------------------------------------

fn btw_record_frame(id: &str, status: &str) -> Value {
    json!({ "record": { "id": id, "leafId": format!("{id}-leaf"), "question": "q", "answer": "a", "status": status, "createdAt": 1, "updatedAt": 2, "followUps": [] } })
}

/// Gate-fix (round 2, Verif2 LOW / round 4, Code4 Medium): a `btw_delta` is gated on visibility;
/// a terminal `btw_record` and a `btw-history` save-failure notice are ALWAYS forwarded, even for
/// a Session hidden mid-request -- losing a side chat's own completion, or a save-failure notice,
/// to the visibility gate leaves the panel stuck (or silently wrong) until a reload. Driven
/// through the real `apply_frame` (gate-fix round 2 MEDIUM: replaces direct predicate calls).
#[test]
fn a_btw_delta_is_dropped_while_hidden_but_forwarded_while_visible() {
    let mut state = State::default();
    let frame = json!({ "recordId": "topic-1", "delta": "x" });
    assert_eq!(apply_frame(&mut state, "btw_delta", &frame, false), None);
    assert_eq!(
        apply_frame(&mut state, "btw_delta", &frame, true),
        Some(SideChatPatch::Delta {
            delta: "x".to_string(),
            record_id: "topic-1".to_string()
        })
    );
}

#[test]
fn a_terminal_record_and_a_btw_history_notice_are_forwarded_even_while_hidden() {
    let mut state = State::default();
    let record_frame = btw_record_frame("topic-1", "complete");
    assert!(matches!(
        apply_frame(&mut state, "btw_record", &record_frame, false),
        Some(SideChatPatch::Record { .. })
    ));
    let notice_frame = json!({ "source": "btw-history", "message": "save failed" });
    assert!(matches!(
        apply_frame(&mut state, "notice", &notice_frame, false),
        Some(SideChatPatch::Notice { .. })
    ));
}

/// Gate-fix (round 6, defense in depth; round 2 MEDIUM: epoch bumped to a nonzero value so a
/// real fallback to `conversation_epoch` is distinguishable from a bug that fell back to a
/// hardcoded `0`): a topic never stamped by `ask` at all (loaded from history, never asked
/// through this process instance) must NOT be treated as stale -- only a topic actually stamped
/// with an OLDER epoch is dropped.
#[test]
fn a_topic_never_stamped_falls_back_to_the_current_epoch_and_is_never_stale() {
    let mut state = State {
        conversation_epoch: 3,
        ..Default::default()
    };
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

/// Gate-fix (round 9, Code9/Sec9/A11y9/Verif9 Medium): a STALE terminal frame still removes its
/// own ACTIVE `topic_epoch` entry (settledness-bounded, never by staleness) even though the frame
/// itself is dropped as stale -- moved to `terminal_topic_epoch` (the tombstone, round 2's own
/// leak fix), not forgotten outright.
#[test]
fn a_stale_terminal_frame_is_dropped_but_still_tombstones_its_entry() {
    let mut state = State::default();
    stamp_continuation_before_ask(&mut state, Some("topic-1"));
    state.conversation_epoch = state.conversation_epoch.wrapping_add(1);
    assert!(state.topic_epoch.contains_key("topic-1"));

    let frame = btw_record_frame("topic-1", "complete");
    assert_eq!(apply_frame(&mut state, "btw_record", &frame, true), None);
    assert!(!state.topic_epoch.contains_key("topic-1"));
    assert!(
        state.terminal_topic_epoch.contains_key("topic-1"),
        "a terminal entry must survive as a tombstone, not vanish outright"
    );
}

/// Gate-fix (round 9, wording corrected round 10): deletion is bounded by the LATEST turn's own
/// status, never the root's -- a root left `running` forever (because a follow-up, not the root,
/// settled) must still have its entry deleted once `latest_turn` reports terminal.
#[test]
fn deletion_follows_the_latest_turns_status_not_the_stale_root() {
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
// Real `SessionAgent` harness (same pattern `session::termination.test.rs`'s own
// `make_marker_test_agent` uses) -- needed whenever a test must drive the REAL
// `on_conversation_reset`/`on_exit` (both emit through `EventSink`, which silently no-ops with
// no live Tauri window -- exactly what a unit test needs, but also means `side-chat:conversation-
// changed`/`side-chat:interrupted` themselves cannot be observed firing from here; these tests
// assert on the STATE mutation each one is responsible for instead).
// ---------------------------------------------------------------------------

async fn make_test_agent(
    label: &str,
    initial_conversation: Option<&str>,
) -> std::sync::Arc<SessionAgent> {
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
        current_conversation: initial_conversation.map(str::to_string),
        last_message_count: None,
        last_model: None,
        last_thinking_level: None,
        created_at: now.clone(),
        last_activity_at: now,
        archived_at: None,
        current_turn_subagents: None,
        stopped_on_request_conversation: None,
        stopped_on_request_at_size: None,
        pinned_model: false,
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
            color: None,
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

/// Gate-fix (round 7, Code7/Verif7 Medium), the "stamping order" behaviour, driven through BOTH
/// of `ask`'s own stamp functions (gate-fix round 2 HIGH: the round-1 test never reached the
/// post-response stamp at all): `stamp_continuation_before_ask` captures the epoch BEFORE the
/// request is sent; a REAL Conversation switch (`on_conversation_reset`) then lands while the
/// request is conceptually still in flight; `stamp_topic_after_response` -- `ask`'s own
/// post-response stamp -- runs with that OLD captured epoch, never a value re-read after the
/// switch. The late response must still be dropped as stale.
#[tokio::test]
async fn a_switch_landing_between_the_capture_and_the_post_response_stamp_is_still_caught() {
    let agent = make_test_agent("stamp-order", None).await;
    let epoch = agent
        .with_side_chat_state(|s| stamp_continuation_before_ask(s, None))
        .await;
    on_conversation_reset(&agent).await;
    agent
        .with_side_chat_state(|s| stamp_topic_after_response(s, "topic-1".to_string(), epoch))
        .await;
    let frame = btw_record_frame("topic-1", "complete");
    let patch = agent
        .with_side_chat_state(|s| apply_frame(s, "btw_record", &frame, true))
        .await;
    assert_eq!(
        patch, None,
        "a topic stamped with the epoch captured BEFORE an in-flight switch must be dropped as stale"
    );
}

/// Gate-fix (2026-10-14 gate review round 2 HIGH/CRITICAL, a REAL cross-Conversation leak): a
/// cancelled topic's terminal record used to fully delete its `topic_epoch` entry, so a LATER
/// straggler frame for that SAME topic fell back to `conversation_epoch` itself (`unwrap_or`) and
/// was wrongly treated as current/never-stale once the active entry was gone -- forwarding the
/// old Conversation's leaked text into the new one (Electron has the identical hole; issue #789's
/// own "port the fixed behaviour, not the bug" note has been filed against it). This test FAILS
/// without the `terminal_topic_epoch` tombstone fix: drives a real `ask` stamp, a terminal
/// (cancelled) response, a REAL Conversation switch, then two late straggler frames for the SAME
/// topic -- both must be dropped. A topic asked in the NEW Conversation is unaffected.
#[tokio::test]
async fn a_cancelled_topics_late_frames_are_dropped_even_after_a_conversation_switch() {
    let agent = make_test_agent("leak-fix", None).await;
    agent
        .with_side_chat_state(|s| stamp_continuation_before_ask(s, Some("topic-2")))
        .await;
    let cancelled = btw_record_frame("topic-2", "cancelled");
    let cancel_patch = agent
        .with_side_chat_state(|s| apply_frame(s, "btw_record", &cancelled, true))
        .await;
    assert!(matches!(cancel_patch, Some(SideChatPatch::Record { .. })));

    on_conversation_reset(&agent).await; // the switch that follows the cancel

    let late_delta = json!({ "recordId": "topic-2", "delta": "leaked text" });
    let late_delta_patch = agent
        .with_side_chat_state(|s| apply_frame(s, "btw_delta", &late_delta, true))
        .await;
    assert_eq!(
        late_delta_patch, None,
        "a late delta for an already-cancelled, pre-switch topic must never leak into the new Conversation"
    );

    let late_record = btw_record_frame("topic-2", "complete");
    let late_record_patch = agent
        .with_side_chat_state(|s| apply_frame(s, "btw_record", &late_record, true))
        .await;
    assert_eq!(
        late_record_patch, None,
        "a late terminal record for the same pre-switch topic must never leak either"
    );

    // A topic asked in the NEW (post-switch) Conversation is unaffected.
    agent
        .with_side_chat_state(|s| stamp_continuation_before_ask(s, Some("topic-3")))
        .await;
    let current_delta = json!({ "recordId": "topic-3", "delta": "fine" });
    let current_patch = agent
        .with_side_chat_state(|s| apply_frame(s, "btw_delta", &current_delta, true))
        .await;
    assert_eq!(
        current_patch,
        Some(SideChatPatch::Delta {
            delta: "fine".to_string(),
            record_id: "topic-3".to_string()
        })
    );
}

/// Port of `SessionAgent.ts`'s own `onExit`: both maps are cleared unconditionally on every
/// process exit, regardless of what was in them.
#[tokio::test]
async fn on_exit_clears_both_epoch_maps_unconditionally() {
    let agent = make_test_agent("on-exit", None).await;
    agent
        .with_side_chat_state(|s| {
            s.topic_epoch.insert("left-running".to_string(), 0);
            s.terminal_topic_epoch
                .insert("already-terminal".to_string(), 0);
            s.conversation_epoch = 5;
        })
        .await;
    on_exit(&agent, None, false).await;
    let (topic_epoch_len, terminal_len, conversation_epoch) = agent
        .with_side_chat_state(|s| {
            (
                s.topic_epoch.len(),
                s.terminal_topic_epoch.len(),
                s.conversation_epoch,
            )
        })
        .await;
    assert_eq!(topic_epoch_len, 0);
    assert_eq!(terminal_len, 0);
    // `on_exit` only clears the epoch maps, never the Conversation epoch itself.
    assert_eq!(conversation_epoch, 5);
}

/// `on_conversation_reset` bumps the epoch exactly once per call. Gate-fix (round 3 MEDIUM):
/// tombstones must SURVIVE every reset now -- round 2's own per-reset prune (keep only the
/// retiring generation) is what caused the two-switch leak
/// (`a_tombstone_survives_a_second_conversation_switch_after_a_late_cancel` below); asserted
/// directly here, across TWO resets, so a regression back to pruning is caught without needing
/// the full end-to-end scenario.
#[tokio::test]
async fn on_conversation_reset_bumps_the_epoch_once_and_never_prunes_tombstones() {
    let agent = make_test_agent("conv-reset", None).await;
    let before = agent
        .with_side_chat_state(|s| {
            s.terminal_topic_epoch
                .insert("old-tombstone".to_string(), 0);
            s.terminal_topic_order
                .push_back("old-tombstone".to_string());
            s.conversation_epoch
        })
        .await;
    on_conversation_reset(&agent).await;
    on_conversation_reset(&agent).await; // a second reset -- round 2's bug only showed up after this
    let (after, still_there) = agent
        .with_side_chat_state(|s| {
            (
                s.conversation_epoch,
                s.terminal_topic_epoch.contains_key("old-tombstone"),
            )
        })
        .await;
    assert_eq!(after, before.wrapping_add(2));
    assert!(
        still_there,
        "a tombstone must never be pruned by a reset any more"
    );
}

/// Gate-fix (round 3 MEDIUM, security Low): `tombstone_topic`'s own FIFO cap bounds
/// `terminal_topic_epoch` regardless of how many topics a session's whole lifetime ever asks --
/// the oldest tombstone is evicted once `MAX_TOMBSTONES` is exceeded.
#[test]
fn tombstone_topic_evicts_the_oldest_once_the_fifo_cap_is_exceeded() {
    let mut state = State::default();
    for i in 0..300 {
        let id = format!("topic-{i}");
        state.topic_epoch.insert(id.clone(), 0);
        let removed_epoch = state.topic_epoch.remove(&id).unwrap();
        tombstone_topic(&mut state, id, removed_epoch);
    }
    assert_eq!(state.terminal_topic_epoch.len(), 256);
    assert!(
        !state.terminal_topic_epoch.contains_key("topic-0"),
        "the oldest tombstone must have been evicted"
    );
    assert!(
        state.terminal_topic_epoch.contains_key("topic-299"),
        "the newest tombstone must still be present"
    );
}

/// Gate-fix (round 3 MEDIUM, a deeper cross-Conversation leak the round 2 fix still had): a
/// cancel record arriving AFTER a switch is tombstoned with the epoch `topic_epoch.remove`
/// actually returns (the stamped-before epoch) -- round 2's own per-reset prune then wrongly
/// treated that as "an older generation" and dropped it at the VERY NEXT reset, so a late frame
/// arriving after a SECOND switch leaked. Drives exactly that sequence: stamp at epoch 0, switch
/// #1 (the cancel hasn't arrived yet), the cancel arrives only now, switch #2 -- a late frame
/// afterward must still be dropped. This test FAILS against round 2's own per-reset prune.
#[tokio::test]
async fn a_tombstone_survives_a_second_conversation_switch_after_a_late_cancel() {
    let agent = make_test_agent("leak-fix-two-switch", None).await;
    agent
        .with_side_chat_state(|s| stamp_continuation_before_ask(s, Some("topic-9")))
        .await;

    on_conversation_reset(&agent).await; // switch #1 -- the cancel hasn't arrived yet

    let cancelled = btw_record_frame("topic-9", "cancelled");
    let cancel_patch = agent
        .with_side_chat_state(|s| apply_frame(s, "btw_record", &cancelled, true))
        .await;
    assert_eq!(
        cancel_patch, None,
        "the cancel record itself, stamped at the OLD epoch, is already stale by switch #1"
    );

    on_conversation_reset(&agent).await; // switch #2 -- round 2's own bug pruned the tombstone here

    let late_delta = json!({ "recordId": "topic-9", "delta": "leaked after two switches" });
    let late_patch = agent
        .with_side_chat_state(|s| apply_frame(s, "btw_delta", &late_delta, true))
        .await;
    assert_eq!(
        late_patch, None,
        "a tombstone must survive a SECOND switch, not just the first"
    );
}

// ---------------------------------------------------------------------------
// `reset_after_start_with_conversation` (gate-fix, 2026-10-14 gate review round 1 HIGH: a stopped
// Session's Conversation switch used to never reset side chat at all)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn reset_after_start_with_conversation_skips_when_the_worktree_write_never_happened() {
    let agent = make_test_agent("skip-no-write", None).await;
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
    let agent = make_test_agent("reset-changed", None).await;
    let before = agent.with_side_chat_state(|s| s.conversation_epoch).await;
    reset_after_start_with_conversation(&agent, Some("file-b"), Some(Some("file-a".to_string())))
        .await;
    let after = agent.with_side_chat_state(|s| s.conversation_epoch).await;
    assert_eq!(after, before.wrapping_add(1));
}

#[tokio::test]
async fn reset_after_start_with_conversation_always_resets_for_a_brand_new_conversation() {
    let agent = make_test_agent("reset-new", None).await;
    let before = agent.with_side_chat_state(|s| s.conversation_epoch).await;
    // `file: None` always resets, even though `previous_conversation` was also `None`.
    reset_after_start_with_conversation(&agent, None, Some(None)).await;
    let after = agent.with_side_chat_state(|s| s.conversation_epoch).await;
    assert_eq!(after, before.wrapping_add(1));
}

#[tokio::test]
async fn reset_after_start_with_conversation_skips_reopening_the_same_conversation() {
    let agent = make_test_agent("reset-same", None).await;
    let before = agent.with_side_chat_state(|s| s.conversation_epoch).await;
    reset_after_start_with_conversation(&agent, Some("file-a"), Some(Some("file-a".to_string())))
        .await;
    let after = agent.with_side_chat_state(|s| s.conversation_epoch).await;
    assert_eq!(
        after, before,
        "reopening the SAME Conversation must not reset side chat"
    );
}

/// Gate-fix (round 2 MEDIUM; renamed round 3 LOW -- the old name claimed to test that `prev` is
/// captured BEFORE `start_with_conversation`'s own `update_session` write, which this does NOT
/// drive; see Not-exercised in the PR body): `reset_after_start_with_conversation` accepts
/// whatever `current_conversation_path` (the real accessor `start_with_conversation` itself
/// calls) genuinely returns, not a hand-picked `Some(Some("file-a"))` literal -- a regression in
/// that accessor itself would still be caught here.
#[tokio::test]
async fn reset_after_start_with_conversation_accepts_the_real_current_conversation_path_result() {
    let agent = make_test_agent("prev-capture", Some("file-a")).await;
    let prev = agent.current_conversation_path().await;
    assert_eq!(
        prev.as_deref(),
        Some("file-a"),
        "current_conversation_path must read the registry's real current_conversation"
    );
    let before = agent.with_side_chat_state(|s| s.conversation_epoch).await;
    reset_after_start_with_conversation(&agent, Some("file-b"), Some(prev)).await;
    let after = agent.with_side_chat_state(|s| s.conversation_epoch).await;
    assert_eq!(after, before.wrapping_add(1));
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
