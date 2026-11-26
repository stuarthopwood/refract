use std::future::Future;
use std::pin::Pin;
use std::sync::Mutex;

use super::*;
use crate::omp::config::{OmpConfigError, OmpConfigErrorCode};

type CallFuture<'a> = Pin<Box<dyn Future<Output = Result<String, OmpConfigError>> + Send + 'a>>;

enum Behaviour {
    Reply(String),
    Fail,
    Hang,
}

/// Records every call, so a test can prove how many model calls were made and with what.
struct FakeExec {
    behaviour: Behaviour,
    calls: Mutex<Vec<(Vec<String>, Option<Duration>)>>,
}

impl FakeExec {
    fn new(behaviour: Behaviour) -> Self {
        Self {
            behaviour,
            calls: Mutex::new(Vec::new()),
        }
    }

    fn replying(reply: &str) -> Self {
        Self::new(Behaviour::Reply(reply.to_string()))
    }

    fn call_count(&self) -> usize {
        self.calls.lock().unwrap().len()
    }

    fn respond<'a>(&'a self, args: &[String], deadline: Option<Duration>) -> CallFuture<'a> {
        self.calls.lock().unwrap().push((args.to_vec(), deadline));
        Box::pin(async move {
            match &self.behaviour {
                Behaviour::Reply(reply) => Ok(reply.clone()),
                Behaviour::Fail => Err(OmpConfigError::new(OmpConfigErrorCode::OmpFailed, "boom")),
                Behaviour::Hang => std::future::pending().await,
            }
        })
    }
}

impl OmpExecutor for FakeExec {
    fn call<'a>(
        &'a self,
        args: &'a [String],
        _failure_message: &'a str,
        _strip_env_vars: &'a [&'a str],
    ) -> CallFuture<'a> {
        self.respond(args, None)
    }

    fn call_with_timeout<'a>(
        &'a self,
        args: &'a [String],
        _failure_message: &'a str,
        _strip_env_vars: &'a [&'a str],
        timeout: Duration,
    ) -> CallFuture<'a> {
        self.respond(args, Some(timeout))
    }
}

fn input(agent_count: usize) -> SynthesisInput {
    SynthesisInput {
        tool_call_id: "t1".into(),
        context: Some("Shared context".into()),
        agents: (0..agent_count)
            .map(|i| (format!("agent{i}"), format!("Do job {i}")))
            .collect(),
    }
}

fn roles(pairs: &[(&str, &str)]) -> HashMap<String, String> {
    pairs
        .iter()
        .map(|(role, selector)| ((*role).to_string(), (*selector).to_string()))
        .collect()
}

const GOOD_REPLY: &str = r#"{"overallGoal": "Ship the card", "roles": ["Researcher", "Builder"]}"#;

// ---- build_prompt ----

#[test]
fn the_prompt_caps_each_task_at_2000_chars_and_the_context_at_4000() {
    let mut input = input(1);
    input.agents[0].1 = "§".repeat(5_000);
    input.context = Some("¶".repeat(9_000));
    let prompt = build_prompt(&input);
    assert_eq!(prompt.matches('§').count(), 1_999);
    assert_eq!(prompt.matches('¶').count(), 3_999);
    assert!(prompt.contains("§…\n"));
}

#[test]
fn a_task_under_the_cap_reaches_the_prompt_whole() {
    let prompt = build_prompt(&input(2));
    assert!(prompt.contains("Agent 1 (agent0):\nDo job 0\n"));
    assert!(prompt.contains("Agent 2 (agent1):\nDo job 1\n"));
    assert!(prompt.contains("Context:\nShared context\n"));
    assert!(prompt.contains("exactly 2 strings"));
}

#[test]
fn a_wide_task_call_shrinks_each_task_so_the_prompt_stays_bounded() {
    let mut input = input(40);
    for agent in &mut input.agents {
        agent.1 = "§".repeat(2_000);
    }
    let prompt = build_prompt(&input);
    assert!(prompt.matches('§').count() <= 40 * 500);
    assert!(prompt.chars().count() < 30_000);
}

#[test]
fn the_rules_hard_section_is_stripped_up_to_the_next_heading() {
    let mut input = input(1);
    input.agents[0].1 =
        "# Goal\nFix the bug\n\n# Rules (HARD)\n- never ask\n- no builds\n\n# Acceptance\nIt passes"
            .into();
    let prompt = build_prompt(&input);
    assert!(prompt.contains("Fix the bug"));
    assert!(prompt.contains("# Acceptance\nIt passes"));
    assert!(!prompt.contains("Rules (HARD)"));
    assert!(!prompt.contains("never ask"));
}

#[test]
fn a_rules_section_at_the_end_of_the_text_is_stripped_to_the_end() {
    let mut input = input(1);
    input.context = Some("Goal text\n**Rules (HARD)**\n- alpharule\n- betarule".into());
    let prompt = build_prompt(&input);
    assert!(prompt.contains("Goal text"));
    assert!(!prompt.contains("alpharule") && !prompt.contains("betarule"));
}

#[test]
fn worktree_paths_are_rewritten_and_the_path_below_the_root_is_kept() {
    let mut input = input(1);
    input.agents[0].1 =
        "Edit `C:/Repos/personal/pinion-worktrees/lane-1925-rust/src-tauri/src/a.rs` and C:\\Repos\\wt\\worktrees\\lane\\b.rs now"
            .into();
    let prompt = build_prompt(&input);
    assert!(prompt.contains("Edit `<worktree>/src-tauri/src/a.rs` and <worktree>/b.rs now"));
    assert!(!prompt.contains("pinion-worktrees"));
}

#[test]
fn a_path_that_is_not_in_a_worktree_is_left_alone() {
    let mut input = input(1);
    input.agents[0].1 = "Read /usr/lib/thing and C:/Repos/app/src/a.rs".into();
    let prompt = build_prompt(&input);
    assert!(prompt.contains("Read /usr/lib/thing and C:/Repos/app/src/a.rs"));
}

#[test]
fn the_prompt_asks_for_the_json_shape_and_never_leaks_the_tool_call_id() {
    let mut input = input(1);
    input.tool_call_id = "toolcall-secret".into();
    let prompt = build_prompt(&input);
    assert!(prompt.contains(r#"{"overallGoal": "...", "roles": ["..."]}"#));
    assert!(!prompt.contains("toolcall-secret"));
}

// ---- parse_reply ----

#[test]
fn a_plain_json_reply_parses() {
    let parsed = parse_reply(GOOD_REPLY, 2).unwrap();
    assert_eq!(parsed.overall_goal.as_deref(), Some("Ship the card"));
    assert_eq!(
        parsed.roles,
        vec![Some("Researcher".to_string()), Some("Builder".to_string())]
    );
}

#[test]
fn a_fenced_or_prose_wrapped_reply_parses() {
    let fenced = format!("```json\n{GOOD_REPLY}\n```");
    assert_eq!(parse_reply(&fenced, 2), parse_reply(GOOD_REPLY, 2));
    let prose = format!("Sure! Here you go: {GOOD_REPLY} Hope that helps.");
    assert_eq!(parse_reply(&prose, 2), parse_reply(GOOD_REPLY, 2));
}

#[test]
fn an_over_long_goal_and_role_are_cut_on_char_boundaries() {
    let reply = format!(
        r#"{{"overallGoal": "{}", "roles": ["{}"]}}"#,
        "é".repeat(200),
        "🦀".repeat(60)
    );
    let parsed = parse_reply(&reply, 1).unwrap();
    assert_eq!(parsed.overall_goal.unwrap().chars().count(), 120);
    assert_eq!(parsed.roles[0].as_ref().unwrap().chars().count(), 40);
}

#[test]
fn too_few_roles_are_padded_and_too_many_are_trimmed_to_the_agent_count() {
    let padded = parse_reply(GOOD_REPLY, 3).unwrap();
    assert_eq!(padded.roles.len(), 3);
    assert_eq!(padded.roles[2], None);
    let trimmed = parse_reply(GOOD_REPLY, 1).unwrap();
    assert_eq!(trimmed.roles, vec![Some("Researcher".to_string())]);
}

#[test]
fn a_reply_missing_the_goal_keeps_the_roles_and_the_other_way_round() {
    let only_roles = parse_reply(r#"{"roles": ["A", "B"]}"#, 2).unwrap();
    assert_eq!(only_roles.overall_goal, None);
    assert_eq!(only_roles.roles.len(), 2);
    let only_goal = parse_reply(r#"{"overallGoal": "Do it"}"#, 2).unwrap();
    assert_eq!(only_goal.overall_goal.as_deref(), Some("Do it"));
    assert_eq!(only_goal.roles, vec![None, None]);
}

#[test]
fn wrong_typed_and_blank_entries_are_dropped_and_the_rest_kept() {
    let parsed = parse_reply(
        r#"{"overallGoal": 7, "roles": ["Builder", 3, "  ", null, "Tester"]}"#,
        5,
    )
    .unwrap();
    assert_eq!(parsed.overall_goal, None);
    assert_eq!(
        parsed.roles,
        vec![
            Some("Builder".to_string()),
            None,
            None,
            None,
            Some("Tester".to_string())
        ]
    );
}

#[test]
fn newlines_inside_a_label_collapse_to_one_line() {
    let parsed = parse_reply(r#"{"overallGoal": "Ship\n  the   card"}"#, 0).unwrap();
    assert_eq!(parsed.overall_goal.as_deref(), Some("Ship the card"));
}

#[test]
fn a_reply_with_no_usable_labels_is_none() {
    assert_eq!(parse_reply("I cannot help with that.", 2), None);
    assert_eq!(parse_reply("{not json}", 2), None);
    assert_eq!(parse_reply(r#"{"overallGoal": "", "roles": []}"#, 2), None);
    assert_eq!(parse_reply("[]", 2), None);
    assert_eq!(parse_reply("", 2), None);
}

// ---- resolve_tiny_selector ----

#[test]
fn an_unset_tiny_role_resolves_to_nothing_even_when_default_is_set() {
    assert_eq!(resolve_tiny_selector(&roles(&[])), None);
    assert_eq!(
        resolve_tiny_selector(&roles(&[("default", "a/big"), ("smol", "a/mid")])),
        None
    );
}

#[test]
fn a_distinct_tiny_role_resolves_to_its_selector() {
    let model_roles = roles(&[("default", "a/big"), ("smol", "a/mid"), ("tiny", "a/small")]);
    assert_eq!(
        resolve_tiny_selector(&model_roles).as_deref(),
        Some("a/small")
    );
}

#[test]
fn tiny_that_is_default_or_smol_directly_or_by_alias_resolves_to_nothing() {
    for tiny in ["a/big", "@default", "*", "a/big:high"] {
        let model_roles = roles(&[("default", "a/big"), ("tiny", tiny)]);
        assert_eq!(resolve_tiny_selector(&model_roles), None, "tiny={tiny}");
    }
    let model_roles = roles(&[("default", "a/big"), ("smol", "a/mid"), ("tiny", "a/mid")]);
    assert_eq!(resolve_tiny_selector(&model_roles), None);
    let inherited = roles(&[("default", "a/big"), ("tiny", "@smol")]);
    assert_eq!(resolve_tiny_selector(&inherited), None);
}

#[test]
fn a_tiny_selector_that_is_not_valid_resolves_to_nothing() {
    assert_eq!(resolve_tiny_selector(&roles(&[("tiny", "   ")])), None);
    assert_eq!(resolve_tiny_selector(&roles(&[("tiny", "a/x\ny")])), None);
}

// ---- run_synthesis and synthesize ----

#[tokio::test]
async fn one_input_makes_one_call_with_the_tiny_selector_and_the_prompt() {
    let exec = FakeExec::replying(GOOD_REPLY);
    let input = input(2);
    let result = run_synthesis(&exec, "a/small", &input).await.unwrap();
    assert_eq!(result.overall_goal.as_deref(), Some("Ship the card"));
    let calls = exec.calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    let (args, deadline) = &calls[0];
    assert_eq!(*deadline, Some(Duration::from_secs(30)));
    assert_eq!(args[0], "-p");
    for flag in [
        "--no-session",
        "--no-tools",
        "--no-extensions",
        "--no-skills",
        "--no-rules",
        "--no-context-files",
        "--no-title",
    ] {
        assert!(args.iter().any(|a| a == flag), "missing {flag}");
    }
    assert!(args.contains(&"--model=a/small".to_string()));
    assert_eq!(args.last().unwrap(), &build_prompt(&input));
}

#[tokio::test]
async fn a_failed_call_is_none_and_is_not_retried() {
    let exec = FakeExec::new(Behaviour::Fail);
    assert_eq!(run_synthesis(&exec, "a/small", &input(2)).await, None);
    assert_eq!(exec.call_count(), 1);
}

#[tokio::test(start_paused = true)]
async fn a_call_that_never_returns_times_out_to_none_and_is_not_retried() {
    let exec = FakeExec::new(Behaviour::Hang);
    assert_eq!(run_synthesis(&exec, "a/small", &input(2)).await, None);
    assert_eq!(exec.call_count(), 1);
}

#[tokio::test]
async fn an_unparseable_reply_is_none_and_is_not_retried() {
    let exec = FakeExec::replying("no json here");
    assert_eq!(run_synthesis(&exec, "a/small", &input(2)).await, None);
    assert_eq!(exec.call_count(), 1);
}

#[tokio::test]
async fn an_input_with_no_agents_makes_no_call() {
    let exec = FakeExec::replying(GOOD_REPLY);
    assert_eq!(run_synthesis(&exec, "a/small", &input(0)).await, None);
    assert_eq!(exec.call_count(), 0);
}

#[tokio::test]
async fn an_unset_or_default_or_smol_tiny_role_makes_no_model_call() {
    let exec = FakeExec::replying(GOOD_REPLY);
    for model_roles in [
        roles(&[("default", "a/big"), ("smol", "a/mid")]),
        roles(&[("default", "a/big"), ("tiny", "@default")]),
        roles(&[("default", "a/big"), ("smol", "a/mid"), ("tiny", "a/mid")]),
    ] {
        assert_eq!(synthesize(&exec, &model_roles, &input(2)).await, None);
    }
    assert_eq!(exec.call_count(), 0);
}

#[tokio::test]
async fn synthesize_requests_only_the_tiny_model() {
    let exec = FakeExec::replying(GOOD_REPLY);
    let model_roles = roles(&[("default", "a/big"), ("smol", "a/mid"), ("tiny", "a/small")]);
    assert!(synthesize(&exec, &model_roles, &input(2)).await.is_some());
    let calls = exec.calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    let models: Vec<&String> = calls[0]
        .0
        .iter()
        .filter(|a| a.starts_with("--model"))
        .collect();
    assert_eq!(models, ["--model=a/small"]);
    assert!(!calls[0]
        .0
        .iter()
        .any(|a| a.contains("a/big") || a.contains("a/mid")));
}
