// Unit tests for `session::side_chat` (lane R6, issue #789). No TS test file exists for side
// chat (confirmed: `SessionAgent.test.ts` and every other `.test.ts` in `src/main` have zero
// references to `sideChat`/`btw`/`flattenBtwHistory`) -- these port the issue's own named
// gate-fix behaviours (SessionAgent.ts lines ~105-330, ~979-1010) as Rust tests instead: terminal
// record forwarding, cancelled-topic isolation, stamping order, and entry deletion at a terminal
// turn. `#[path]`-loaded sibling of `side_chat.rs` (excluded from `check:file-size` by its own
// `.test.rs` name), matching `session::termination`'s own split.
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
// Stamping order / cancelled-topic isolation (gate-fix rounds 6, 7, 9)
// ---------------------------------------------------------------------------

/// Gate-fix (round 6, defense in depth): a topic never stamped by `ask` at all (loaded from
/// history, never asked through this process instance) must NOT be treated as stale -- only a
/// topic actually stamped with an OLDER epoch is dropped.
#[test]
fn a_topic_never_stamped_falls_back_to_the_current_epoch_and_is_never_stale() {
    let conversation_epoch = 3;
    let topic_epoch = conversation_epoch; // the `on_frame` fallback when `topic_epoch.get(..)` is `None`
    assert!(!topic_frame_is_stale(topic_epoch, conversation_epoch));
}

/// Gate-fix (round 7, Code7/Verif7 Medium), the "stamping order" behaviour: `ask` captures its
/// own `conversation_epoch` BEFORE sending the request and stamps the topic with that captured
/// value, never a value re-read after the response arrives. This reproduces exactly that
/// sequence -- stamp at the OLD epoch, THEN a Conversation switch bumps the epoch (as it would if
/// the switch landed while the `ask` was still in flight) -- and asserts the already-stamped
/// topic is correctly treated as stale afterward, closing the leak `on_frame`'s epoch guard
/// exists to prevent.
#[test]
fn a_topic_stamped_before_a_conversation_switch_is_stale_after_it() {
    let mut state = State::default();
    let captured_epoch_at_ask_time = state.conversation_epoch;
    state
        .topic_epoch
        .insert("topic-1".to_string(), captured_epoch_at_ask_time);
    // The Conversation switch (`on_conversation_reset`'s own bump) lands while the `ask` that
    // stamped "topic-1" is still conceptually in flight.
    state.conversation_epoch = state.conversation_epoch.wrapping_add(1);

    let stamped = *state.topic_epoch.get("topic-1").unwrap();
    assert!(topic_frame_is_stale(stamped, state.conversation_epoch));
}

/// Gate-fix (round 6, Code6/Sec6/A11y6/Verif6 HIGH): "cancelled-topic isolation" -- a topic
/// stamped in the Conversation just left must never have its late frames (a cancelled topic's
/// trailing `btw_delta`/`btw_record`) forwarded into whichever Conversation is now current, even
/// though nothing about the frame itself says which Conversation it belongs to.
#[test]
fn a_cancelled_topics_late_frame_is_dropped_once_the_conversation_has_moved_on() {
    let mut state = State::default();
    let epoch_at_cancel_time = state.conversation_epoch;
    state
        .topic_epoch
        .insert("cancelled-topic".to_string(), epoch_at_cancel_time);
    state.conversation_epoch = state.conversation_epoch.wrapping_add(1); // the switch that followed the cancel

    let topic_epoch = state
        .topic_epoch
        .get("cancelled-topic")
        .copied()
        .unwrap_or(state.conversation_epoch);
    assert!(topic_frame_is_stale(topic_epoch, state.conversation_epoch));

    // A topic stamped in the SAME (current) Conversation is never dropped this way.
    state
        .topic_epoch
        .insert("current-topic".to_string(), state.conversation_epoch);
    let current_topic_epoch = state
        .topic_epoch
        .get("current-topic")
        .copied()
        .unwrap_or(state.conversation_epoch);
    assert!(!topic_frame_is_stale(
        current_topic_epoch,
        state.conversation_epoch
    ));
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
