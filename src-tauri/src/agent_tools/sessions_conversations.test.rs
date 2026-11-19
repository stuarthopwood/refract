use std::collections::HashSet;
use std::sync::Mutex;
use std::time::Duration;

use serde_json::json;

use super::*;
use crate::agent_tools::router::DENIED;
use crate::agent_tools::sessions_end::tests::{host, parts, row};
use crate::agent_tools::sessions_send::INVALID_TARGET;
use crate::store::session_kind::SessionKind;

/// Stands in for the running app: serves one fixed list of Conversations, records every action in
/// order, and answers the queue the way a test sets it.
struct ConvFake {
    caller: String,
    registry: SharedRegistry,
    yolo: bool,
    approve: bool,
    deleting: Mutex<HashSet<String>>,
    paused: Mutex<HashSet<String>>,
    convs: Vec<ConvRow>,
    mid_turn: bool,
    cards: Mutex<Vec<PendingRequest>>,
    calls: Mutex<Vec<String>>,
    /// Whether the Project's tree gate was held at each queue or start call.
    held: Mutex<Vec<bool>>,
}

impl ConvHost for ConvFake {
    fn caller_id(&self) -> &str {
        &self.caller
    }
    fn call_id(&self) -> &str {
        "call-1"
    }
    fn registry(&self) -> &SharedRegistry {
        &self.registry
    }
    fn is_deleting(&self, id: &str) -> bool {
        self.deleting.lock().unwrap().contains(id)
    }
    async fn is_yolo(&self) -> bool {
        self.yolo
    }
    async fn ask(&self, card: PendingRequest) -> Result<(), ToolError> {
        self.cards.lock().unwrap().push(card);
        if self.approve {
            Ok(())
        } else {
            Err(ToolError::new(DENIED, "the developer denied this action"))
        }
    }
    async fn is_paused(&self, id: &str) -> bool {
        self.paused.lock().unwrap().contains(id)
    }
    async fn conversations(&self, _id: &str) -> Vec<ConvRow> {
        self.convs.clone()
    }
    async fn queue(
        &self,
        id: &str,
        action: HandoffAction,
        sender: Option<(String, String)>,
        asked: bool,
    ) -> Result<QueueOutcome, ToolError> {
        self.note_gate().await;
        self.calls
            .lock()
            .unwrap()
            .push(format!("queue:{id}:{action:?}:{sender:?}:asked={asked}"));
        Ok(if self.mid_turn {
            QueueOutcome::Queued
        } else {
            QueueOutcome::NotMidTurn
        })
    }
    async fn start_new(&self, id: &str, first: FirstMessage) -> Result<(), ToolError> {
        self.note_gate().await;
        self.calls
            .lock()
            .unwrap()
            .push(format!("start:{id}:{}:{}", first.handoff_note, first.text));
        Ok(())
    }
    async fn switch(&self, id: &str, file: String) -> Result<(), ToolError> {
        self.calls
            .lock()
            .unwrap()
            .push(format!("switch:{id}:{file}"));
        Ok(())
    }
}

impl ConvFake {
    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }

    async fn note_gate(&self) {
        let free = tokio::time::timeout(Duration::from_millis(50), tree_gate::lock("repo")).await;
        self.held.lock().unwrap().push(free.is_err());
    }
}

/// me -> kid -> grandkid, a root `side` beside `me`, and `foreign` in another Project.
fn tree() -> Vec<Session> {
    vec![
        row("me", "repo", None),
        row("kid", "repo", Some("me")),
        row("grandkid", "repo", Some("kid")),
        row("side", "repo", None),
        row("foreign", "elsewhere", None),
    ]
}

async fn fake(convs: Vec<ConvRow>) -> ConvFake {
    let end = host(tree()).await;
    ConvFake {
        caller: "me".into(),
        registry: end.registry.clone(),
        yolo: false,
        approve: true,
        deleting: Mutex::new(HashSet::new()),
        paused: Mutex::new(HashSet::new()),
        convs,
        mid_turn: false,
        cards: Mutex::new(Vec::new()),
        calls: Mutex::new(Vec::new()),
        held: Mutex::new(Vec::new()),
    }
}

fn conv(n: u32, preview: &str) -> ConvRow {
    ConvRow {
        id: format!("c{n}"),
        title: format!("title {n}"),
        created_at: format!("2026-01-{n:02}T00:00:00.000Z"),
        preview: preview.into(),
        is_current: n == 1,
        file: format!("c{n}.jsonl"),
    }
}

fn code<T: std::fmt::Debug>(result: Result<T, ToolError>) -> String {
    result.expect_err("expected a tool error").code
}

// Arguments

#[test]
fn list_arguments_default_to_twenty_and_bound_the_limit() {
    assert_eq!(parse_list(&json!({})).unwrap(), (None, 20));
    assert_eq!(parse_list(&json!({ "limit": 1 })).unwrap().1, 1);
    assert_eq!(parse_list(&json!({ "limit": 100 })).unwrap().1, 100);
    for bad in [json!(0), json!(101), json!(-1), json!(1.5), json!("5")] {
        assert_eq!(code(parse_list(&json!({ "limit": bad }))), INVALID_INPUT);
    }
    assert_eq!(
        code(parse_list(&json!({ "session_id": "" }))),
        INVALID_INPUT
    );
    assert_eq!(code(parse_list(&json!({ "extra": 1 }))), INVALID_INPUT);
}

#[test]
fn new_needs_a_prompt_within_the_size_cap() {
    let (id, prompt) = parse_new(&json!({ "prompt": "go", "session_id": "kid" })).unwrap();
    assert_eq!((id.as_deref(), prompt.as_str()), (Some("kid"), "go"));
    assert_eq!(code(parse_new(&json!({}))), INVALID_INPUT);
    assert_eq!(code(parse_new(&json!({ "prompt": " " }))), INVALID_INPUT);
    let big = "x".repeat(MAX_TEXT_BYTES + 1);
    assert_eq!(code(parse_new(&json!({ "prompt": big }))), INVALID_INPUT);
}

#[test]
fn switch_needs_both_ids() {
    assert_eq!(
        parse_switch(&json!({ "session_id": "kid", "conversation_id": "c1" })).unwrap(),
        ("kid".to_string(), "c1".to_string())
    );
    assert_eq!(
        code(parse_switch(&json!({ "session_id": "kid" }))),
        INVALID_INPUT
    );
    assert_eq!(
        code(parse_switch(&json!({ "conversation_id": "c1" }))),
        INVALID_INPUT
    );
}

// Target resolution

#[test]
fn the_target_defaults_to_the_caller_and_is_classified_by_id() {
    let sessions = tree();
    let pick = |caller: &str, target: Option<&str>| {
        resolve_target(&sessions, caller, target).map(|(row, rel)| (row.id.clone(), rel))
    };
    assert_eq!(pick("me", None).unwrap(), ("me".into(), Relationship::Own));
    assert_eq!(pick("me", Some("me")).unwrap().1, Relationship::Own);
    assert_eq!(
        pick("me", Some("grandkid")).unwrap().1,
        Relationship::Descendant
    );
    assert_eq!(pick("me", Some("side")).unwrap().1, Relationship::Sibling);
}

#[test]
fn an_ancestor_the_personal_agent_and_other_projects_are_refused() {
    let mut sessions = tree();
    let mut personal = row("personal", "repo", None);
    personal.kind = SessionKind::Personal;
    personal.repository_id = None;
    sessions.push(personal);

    let refused = |caller: &str, target: &str| {
        code(resolve_target(&sessions, caller, Some(target)).map(|(row, _)| row.id.clone()))
    };
    assert_eq!(refused("grandkid", "me"), INVALID_TARGET);
    assert_eq!(refused("me", "personal"), INVALID_TARGET);
    assert_eq!(refused("me", "foreign"), NOT_FOUND);
    assert_eq!(refused("me", "nobody"), NOT_FOUND);
}

#[test]
fn only_a_session_outside_the_callers_tree_asks_and_yolo_skips_it() {
    assert!(needs_card(Relationship::Sibling, false));
    assert!(!needs_card(Relationship::Sibling, true));
    assert!(!needs_card(Relationship::Own, false));
    assert!(!needs_card(Relationship::Descendant, false));
}

// The state gate

#[tokio::test]
async fn paused_archived_and_deleting_targets_are_refused_but_reads_pass() {
    let fx = fake(vec![]).await;
    fx.paused.lock().unwrap().insert("kid".into());
    fx.deleting.lock().unwrap().insert("side".into());

    assert_eq!(
        code(open_gate(&fx, Some("kid"), true).await.map(|_| ())),
        INVALID_STATE
    );
    assert_eq!(
        code(open_gate(&fx, Some("side"), true).await.map(|_| ())),
        INVALID_STATE
    );
    assert!(open_gate(&fx, Some("kid"), false).await.is_ok());
    assert!(open_gate(&fx, Some("grandkid"), true).await.is_ok());

    fx.registry
        .lock()
        .await
        .update_session(
            "grandkid",
            crate::store::registry::SessionPatch {
                archived_at: Some(Some("2026-02-01T00:00:00.000Z".into())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(
        code(open_gate(&fx, Some("grandkid"), true).await.map(|_| ())),
        INVALID_STATE
    );
}

// The card and the re-check

#[tokio::test]
async fn a_sibling_raises_a_card_led_by_its_id_and_yolo_does_not() {
    let mut fx = fake(vec![]).await;
    let gate = open_gate(&fx, Some("side"), true).await.unwrap();

    assert!(confirm(&fx, ConvTool::New, &gate, "do the thing")
        .await
        .unwrap());
    let card = fx.cards.lock().unwrap().remove(0);
    let (title, details) = parts(&card);
    assert!(title.contains("side"), "{title}");
    assert!(details.iter().any(|d| d == "Outside this Session's tree"));
    assert!(details.iter().any(|d| d == "do the thing"));

    fx.yolo = true;
    assert!(!confirm(&fx, ConvTool::New, &gate, "").await.unwrap());
    assert_eq!(fx.cards.lock().unwrap().len(), 0);
}

#[tokio::test]
async fn a_denied_card_stops_the_call() {
    let mut fx = fake(vec![]).await;
    fx.approve = false;
    let gate = open_gate(&fx, Some("side"), true).await.unwrap();

    assert_eq!(
        code(confirm(&fx, ConvTool::Switch, &gate, "").await),
        DENIED
    );
}

#[tokio::test]
async fn a_call_that_showed_no_card_is_refused_when_the_target_moves_out_of_the_tree() {
    let fx = fake(vec![]).await;
    let gate = open_gate(&fx, Some("grandkid"), true).await.unwrap();
    assert_eq!(gate.relationship, Relationship::Descendant);
    fx.registry
        .lock()
        .await
        .update_session(
            "kid",
            crate::store::registry::SessionPatch {
                parent_session_id: Some(None),
                ..Default::default()
            },
        )
        .await
        .unwrap();

    let result = recheck(&fx, &gate, false).await.map(|_| ());

    assert_eq!(code(result), INVALID_STATE);
}

#[tokio::test]
async fn a_target_removed_while_the_card_was_open_is_invalid_state() {
    let fx = fake(vec![]).await;
    let gate = open_gate(&fx, Some("side"), true).await.unwrap();
    fx.registry
        .lock()
        .await
        .remove_session("side")
        .await
        .unwrap();

    assert_eq!(
        code(recheck(&fx, &gate, true).await.map(|_| ())),
        INVALID_STATE
    );
}

// Defer or run

#[tokio::test]
async fn a_mid_turn_target_defers_and_nothing_starts() {
    let mut fx = fake(vec![]).await;
    fx.mid_turn = true;

    let outcome = dispatch(
        &fx,
        "kid",
        HandoffAction::New {
            prompt: "go".into(),
        },
        None,
        false,
    )
    .await
    .unwrap();

    assert_eq!(outcome, Dispatch::Scheduled);
    assert_eq!(fx.calls().len(), 1, "{:?}", fx.calls());
    assert!(fx.calls()[0].starts_with("queue:kid:"));
}

#[tokio::test]
async fn a_foreign_prompt_is_wrapped_by_the_envelope() {
    let fx = fake(vec![]).await;
    let sender = Some(("Planner".to_string(), "me".to_string()));

    let outcome = dispatch(
        &fx,
        "side",
        HandoffAction::New {
            prompt: "build it".into(),
        },
        sender,
        false,
    )
    .await
    .unwrap();

    assert_eq!(outcome, Dispatch::Done);
    let wrapped = super::super::envelope::wrap("Planner", "me", "build it");
    assert_eq!(fx.calls()[1], format!("start:side:false:{wrapped}"));
}

#[tokio::test]
async fn a_self_handoff_sends_the_raw_note_marked_as_a_handoff() {
    let fx = fake(vec![]).await;

    dispatch(
        &fx,
        "me",
        HandoffAction::New {
            prompt: "note".into(),
        },
        None,
        false,
    )
    .await
    .unwrap();

    assert_eq!(fx.calls()[1], "start:me:true:note");
}

#[tokio::test]
async fn an_idle_switch_runs_at_once() {
    let fx = fake(vec![]).await;

    let outcome = dispatch(
        &fx,
        "kid",
        HandoffAction::Switch {
            file: "b.jsonl".into(),
        },
        None,
        false,
    )
    .await
    .unwrap();

    assert_eq!(outcome, Dispatch::Done);
    assert_eq!(fx.calls()[1], "switch:kid:b.jsonl");
}

// list_conversations

#[tokio::test]
async fn list_is_newest_first_and_defaults_to_twenty() {
    let convs = (1..=25).map(|n| conv(n, "hi")).collect();
    let fx = fake(convs).await;

    let result = run_with(&fx, ConvTool::List, &json!({})).await.unwrap();

    assert_eq!(result["session_id"], "me");
    let listed = result["conversations"].as_array().unwrap();
    assert_eq!(listed.len(), 20);
    assert_eq!(listed[0]["id"], "c25");
    assert_eq!(listed[19]["id"], "c6");
    assert_eq!(listed[0]["createdAt"], "2026-01-25T00:00:00.000Z");
    assert_eq!(listed[0]["isCurrent"], false);
    assert_eq!(listed[0]["title"], "title 25");
}

#[tokio::test]
async fn list_honours_the_limit_and_refuses_one_past_the_cap() {
    let convs = (1..=30).map(|n| conv(n, "hi")).collect();
    let fx = fake(convs).await;

    let three = run_with(&fx, ConvTool::List, &json!({ "limit": 3 }))
        .await
        .unwrap();
    assert_eq!(three["conversations"].as_array().unwrap().len(), 3);
    assert!(run_with(&fx, ConvTool::List, &json!({ "limit": 100 }))
        .await
        .is_ok());
    let refused = run_with(&fx, ConvTool::List, &json!({ "limit": 101 })).await;
    assert_eq!(code(refused), INVALID_INPUT);
}

#[tokio::test]
async fn list_clips_each_preview_to_120_characters() {
    let fx = fake(vec![conv(1, &"é".repeat(300)), conv(2, "short")]).await;

    let result = run_with(&fx, ConvTool::List, &json!({})).await.unwrap();

    let listed = result["conversations"].as_array().unwrap();
    assert_eq!(listed[0]["preview"], "short");
    assert_eq!(listed[1]["preview"].as_str().unwrap().chars().count(), 120);
    assert_eq!(listed[1]["isCurrent"], true);
}

#[tokio::test]
async fn list_reads_a_sibling_without_a_card_and_still_refuses_other_projects() {
    let fx = fake(vec![conv(1, "hi")]).await;

    let sibling = run_with(&fx, ConvTool::List, &json!({ "session_id": "side" }))
        .await
        .unwrap();
    assert_eq!(sibling["session_id"], "side");
    assert_eq!(fx.cards.lock().unwrap().len(), 0);

    let foreign = run_with(&fx, ConvTool::List, &json!({ "session_id": "foreign" })).await;
    assert_eq!(code(foreign), NOT_FOUND);
}

// Card text and error codes

#[tokio::test]
async fn a_long_prompt_card_states_its_size_and_other_cards_do_not() {
    let fx = fake(vec![]).await;
    let gate = open_gate(&fx, Some("side"), true).await.unwrap();
    let long = "x".repeat(250);
    confirm(&fx, ConvTool::New, &gate, &long).await.unwrap();
    confirm(&fx, ConvTool::New, &gate, "short").await.unwrap();
    confirm(&fx, ConvTool::Switch, &gate, &long).await.unwrap();

    let cards = fx.cards.lock().unwrap();
    let size = "Prompt: 250 characters (first 200 shown)";
    assert!(parts(&cards[0]).1.iter().any(|d| d == size));
    assert!(!parts(&cards[1]).1.iter().any(|d| d.starts_with("Prompt:")));
    assert!(!parts(&cards[2]).1.iter().any(|d| d.starts_with("Prompt:")));
}

#[test]
fn agent_error_codes_map_to_the_tool_contract() {
    let code_of = |code: &'static str| agent_error(code, "boom".into()).code;
    assert_eq!(code_of("invalid-state"), INVALID_STATE);
    assert_eq!(code_of("agent-not-running"), SESSION_NOT_RUNNING);
    assert_eq!(code_of("prompt-failed"), "prompt_failed");
    assert_eq!(agent_error("invalid-state", "boom".into()).message, "boom");
}

// The tree gate

#[tokio::test]
async fn the_tree_gate_is_held_while_the_action_runs_and_freed_after() {
    let fx = fake(vec![]).await;
    let args = json!({ "prompt": "build it", "session_id": "side" });

    run_with(&fx, ConvTool::New, &args).await.unwrap();

    assert_eq!(*fx.held.lock().unwrap(), [true, true]);
    let after = tokio::time::timeout(Duration::from_millis(50), tree_gate::lock("repo")).await;
    assert!(after.is_ok(), "the gate must be released on return");
}

#[path = "sessions_conversations_new.test.rs"]
mod new_tool;
#[path = "sessions_conversations_router.test.rs"]
mod routing;
#[path = "sessions_conversations_switch.test.rs"]
mod switch_tool;
