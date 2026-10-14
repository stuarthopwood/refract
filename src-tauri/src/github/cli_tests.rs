// Unit tests for `cli.rs`'s pure parsing/classification logic: `GhAuthStatusJson` deserialisation
// and flattening, `classify_account_problem`, `handle_line`'s device-code extraction/validation,
// `on_stderr_tail_data`'s char-boundary safety, and `on_exit`'s idempotence. Split from `cli.rs`
// itself (`#[path = "cli_tests.rs"]` at its tail) to stay under the 600-line-per-file cap (issue
// #806), the same pattern `ipc/pull_requests/mapping.rs` already uses.

use super::*;

fn new_flow_shared() -> (
    FlowShared,
    mpsc::UnboundedReceiver<GhLoginFlowEvent>,
    watch::Receiver<bool>,
) {
    let (events_tx, events_rx) = mpsc::unbounded_channel();
    let (exit_tx, exit_rx) = watch::channel(false);
    let shared = FlowShared {
        stdout_buf: StdMutex::new(String::new()),
        stderr_tail: StdMutex::new(String::new()),
        requested: AtomicBool::new(false),
        exited: AtomicBool::new(false),
        exit_tx,
        events_tx,
    };
    (shared, events_rx, exit_rx)
}

// --- GhAuthStatusJson / flatten_auth_status -------------------------------------------------

#[test]
fn flattens_one_account_one_host_success_active() {
    let json = r#"{"hosts":{"github.com":[{"host":"github.com","login":"octocat","active":true,"state":"success"}]}}"#;
    let parsed: GhAuthStatusJson = serde_json::from_str(json).unwrap();
    let entries = flatten_auth_status(parsed);
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].host, "github.com");
    assert_eq!(entries[0].login, "octocat");
    assert!(entries[0].active);
    assert_eq!(entries[0].state, "success");
    assert_eq!(entries[0].problem, None);
}

#[test]
fn flattens_several_accounts_one_host_preserving_order_plus_second_host() {
    let json = r#"{"hosts":{
        "github.com":[
            {"host":"github.com","login":"zed","active":false,"state":"success"},
            {"host":"github.com","login":"alice","active":true,"state":"success"},
            {"host":"github.com","login":"bob","active":false,"state":"success"}
        ],
        "ghe.example.com":[
            {"host":"ghe.example.com","login":"carol","active":true,"state":"success"}
        ]
    }}"#;
    let parsed: GhAuthStatusJson = serde_json::from_str(json).unwrap();
    let entries = flatten_auth_status(parsed);
    assert_eq!(entries.len(), 4);
    let github_com: Vec<&str> = entries
        .iter()
        .filter(|e| e.host == "github.com")
        .map(|e| e.login.as_str())
        .collect();
    // gh's own listing order preserved, non-alphabetical (zed, alice, bob).
    assert_eq!(github_com, vec!["zed", "alice", "bob"]);
    let ghe: Vec<&GhAuthHostEntry> = entries.iter().filter(|e| e.host != "github.com").collect();
    assert_eq!(ghe.len(), 1);
    assert_eq!(ghe[0].login, "carol");
}

#[test]
fn flattens_fully_signed_out_to_empty_vec() {
    let parsed = GhAuthStatusJson::default();
    let entries = flatten_auth_status(parsed);
    assert!(entries.is_empty());
}

// --- classify_account_problem -------------------------------------------------------------

#[test]
fn classify_account_problem_bad_credentials_is_expired() {
    assert_eq!(
        classify_account_problem("failure", Some("401 Bad credentials")),
        Some(GhAccountProblem::Expired)
    );
}

#[test]
fn classify_account_problem_timeout_is_unreachable() {
    assert_eq!(
        classify_account_problem("failure", Some("dial tcp: i/o timeout")),
        Some(GhAccountProblem::Unreachable)
    );
    assert_eq!(
        classify_account_problem("timeout", None),
        Some(GhAccountProblem::Unreachable)
    );
}

#[test]
fn classify_account_problem_other_is_unknown() {
    assert_eq!(
        classify_account_problem("failure", Some("something unexpected happened")),
        Some(GhAccountProblem::Unknown)
    );
}

#[test]
fn classify_account_problem_success_is_none_regardless_of_error() {
    assert_eq!(
        classify_account_problem("success", Some("401 Bad credentials")),
        None
    );
}

// --- handle_line device-code extraction ----------------------------------------------------

#[test]
fn handle_line_emits_well_formed_code() {
    let (shared, mut events_rx, _exit_rx) = new_flow_shared();
    shared.handle_line("! First copy your one-time code: ABCD-1234");
    shared.handle_line("One-time code (ABCD-1234)");
    let event = events_rx.try_recv().expect("expected a Code event");
    match event {
        GhLoginFlowEvent::Code(code) => assert_eq!(code, "ABCD-1234"),
        other => panic!("expected Code event, got {other:?}"),
    }
}

#[test]
fn handle_line_drops_malformed_codes_silently() {
    let (shared, mut events_rx, _exit_rx) = new_flow_shared();
    shared.handle_line("One-time code (short)");
    shared.handle_line("One-time code (lowercase-abcd)");
    shared.handle_line("no parens at all here");
    assert!(events_rx.try_recv().is_err());
}

// --- on_stderr_tail_data char-boundary safety (regression for the slice panic) -------------

#[test]
fn on_stderr_tail_data_never_panics_on_multibyte_boundary() {
    let (shared, _events_rx, _exit_rx) = new_flow_shared();
    // A 4-byte emoji (U+1F600, "😀") at the very front of the chunk, followed by ASCII filler
    // long enough that the appended total crosses STDERR_TAIL_BYTES by 1 byte -- the trim start
    // (`len - STDERR_TAIL_BYTES` == 1) then lands squarely inside the emoji's byte 1 (a UTF-8
    // continuation byte), which is exactly the panic this guards against.
    let filler_len = STDERR_TAIL_BYTES - 3;
    let mut chunk = "😀".to_string();
    chunk.push_str(&"a".repeat(filler_len));
    assert_eq!(chunk.len(), STDERR_TAIL_BYTES + 1);
    shared.on_stderr_tail_data(chunk.as_bytes());
    let tail = shared.stderr_tail.lock().unwrap();
    assert!(tail.len() <= STDERR_TAIL_BYTES);
    assert!(tail.chars().all(|c| c == 'a'));
}

// --- classify_failure ------------------------------------------------------------------

#[test]
fn classify_failure_branches() {
    let (shared, _events_rx, _exit_rx) = new_flow_shared();
    *shared.stderr_tail.lock().unwrap() = "the code expired, try again".to_string();
    assert_eq!(shared.classify_failure(), "The code expired.");

    *shared.stderr_tail.lock().unwrap() = "user declined the request".to_string();
    assert_eq!(shared.classify_failure(), "GitHub declined the sign-in.");

    *shared.stderr_tail.lock().unwrap() = "dial tcp: network is unreachable".to_string();
    assert_eq!(shared.classify_failure(), "Couldn't reach GitHub.");

    *shared.stderr_tail.lock().unwrap() = "some other unexpected failure".to_string();
    assert_eq!(shared.classify_failure(), "Sign-in did not finish.");
}

// --- on_exit idempotence ----------------------------------------------------------------

#[test]
fn on_exit_is_idempotent_sends_exit_exactly_once() {
    let (shared, mut events_rx, _exit_rx) = new_flow_shared();
    shared.on_exit(Some(0));
    shared.on_exit(Some(0));
    let mut exit_count = 0;
    while let Ok(event) = events_rx.try_recv() {
        if matches!(event, GhLoginFlowEvent::Exit(_)) {
            exit_count += 1;
        }
    }
    assert_eq!(exit_count, 1);
}
