// Unit tests for `process::pid_records` (lane R3, issue #786): the record/remove/reap
// read-modify-write logic, driven through the injectable `QueryFn`/`TerminateFn` (and an
// explicit scratch file, never the process-wide `FILE_PATH` global, except for the one dedicated
// global-path test below) so these never depend on a real running process or on test execution
// order. `#[path]`-loaded sibling of `pid_records.rs` (excluded from `check:file-size` by its own
// `.test.rs` name).
use super::*;

fn scratch_file() -> PathBuf {
    std::env::temp_dir().join(format!(
        "refract-pid-records-test-{}-{}.json",
        std::process::id(),
        uuid::Uuid::new_v4()
    ))
}

async fn read_records(file: &Path) -> Vec<ProcessRecord> {
    read_json_file(file, make_default).await.unwrap()
}

const OMP_PATH: &str = r"C:\fake\omp.exe";

fn always_running_omp(_pid: u32) -> Option<(u64, String)> {
    Some((1234, OMP_PATH.to_string()))
}

fn never_running(_pid: u32) -> Option<(u64, String)> {
    None
}

fn running_but_different_process(_pid: u32) -> Option<(u64, String)> {
    // Same pid is now some other process entirely (reused by the OS): a different creation
    // time, so this must never be treated as the same `omp` life.
    Some((9999, OMP_PATH.to_string()))
}

fn running_but_different_path(_pid: u32) -> Option<(u64, String)> {
    Some((1234, r"C:\fake\notepad.exe".to_string()))
}

/// Always reports "not a match" regardless of the record (used where the test only cares that
/// `reap_stale_with`'s own orchestration -- which records get offered to `terminate`, whether
/// the file is cleared afterward -- behaves correctly, not whether any particular identity
/// happens to match).
fn terminate_never(_pid: u32, _start_time: u64, _image_path: &str) -> bool {
    false
}

#[tokio::test]
async fn record_then_remove_round_trips() {
    let file = scratch_file();
    record_process_with(&file, 111, "session-1", always_running_omp).await;
    let records = read_records(&file).await;
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].pid, 111);
    assert_eq!(records[0].session_id, "session-1");
    assert_eq!(records[0].start_time, 1234);
    assert_eq!(records[0].image_path, OMP_PATH);

    remove_process_record_with(&file, 111).await;
    let records = read_records(&file).await;
    assert!(records.is_empty());
    let _ = tokio::fs::remove_file(&file).await;
}

#[tokio::test]
async fn record_replaces_an_earlier_record_for_the_same_pid() {
    let file = scratch_file();
    record_process_with(&file, 222, "session-old", always_running_omp).await;
    record_process_with(&file, 222, "session-new", always_running_omp).await;
    let records = read_records(&file).await;
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].session_id, "session-new");
    let _ = tokio::fs::remove_file(&file).await;
}

#[tokio::test]
async fn remove_of_an_unknown_pid_is_a_harmless_no_op() {
    let file = scratch_file();
    record_process_with(&file, 333, "session-1", always_running_omp).await;
    remove_process_record_with(&file, 999).await;
    let records = read_records(&file).await;
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].pid, 333);
    let _ = tokio::fs::remove_file(&file).await;
}

#[tokio::test]
async fn remove_for_session_drops_every_record_for_that_session_regardless_of_pid() {
    // Gate-fix (security MEDIUM, round 6): `sessions.delete`/`.archive` call this right after
    // their own `shutdown()` so a deleted/archived Session never leaves a stale record behind,
    // for any of the pids it ever recorded (a Session can accumulate more than one over its
    // Conversation history via `/model` switches, restarts, etc.).
    let file = scratch_file();
    record_process_with(&file, 501, "session-a", always_running_omp).await;
    record_process_with(&file, 502, "session-a", always_running_omp).await;
    record_process_with(&file, 503, "session-b", always_running_omp).await;
    remove_process_records_for_session_with(&file, "session-a").await;
    let records = read_records(&file).await;
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].pid, 503);
    assert_eq!(records[0].session_id, "session-b");
    let _ = tokio::fs::remove_file(&file).await;
}

#[tokio::test]
async fn remove_for_an_unknown_session_is_a_harmless_no_op() {
    let file = scratch_file();
    record_process_with(&file, 504, "session-c", always_running_omp).await;
    remove_process_records_for_session_with(&file, "session-does-not-exist").await;
    let records = read_records(&file).await;
    assert_eq!(records.len(), 1);
    let _ = tokio::fs::remove_file(&file).await;
}

#[tokio::test]
async fn reap_never_terminates_when_nothing_matches_but_still_clears_the_file() {
    let file = scratch_file();
    record_process_with(&file, 10, "session-exited", never_running).await;
    record_process_with(&file, 20, "session-reused", running_but_different_process).await;
    record_process_with(&file, 30, "session-not-omp", running_but_different_path).await;

    let stopped = reap_stale_with(&file, terminate_never).await;
    assert_eq!(stopped, 0);
    let records = read_records(&file).await;
    assert!(
        records.is_empty(),
        "every record is cleared after a reap regardless of outcome"
    );
    let _ = tokio::fs::remove_file(&file).await;
}

#[tokio::test]
async fn reap_counts_whatever_terminate_reports() {
    let file = scratch_file();
    record_process_with(&file, 40, "session-live", always_running_omp).await;
    record_process_with(&file, 41, "session-also-live", always_running_omp).await;

    let stopped = reap_stale_with(&file, |_pid, _start, _path| true).await;
    assert_eq!(stopped, 2);
    assert!(read_records(&file).await.is_empty());
    let _ = tokio::fs::remove_file(&file).await;
}

#[tokio::test]
async fn reap_with_no_records_is_a_no_op_that_still_clears_the_file() {
    let file = scratch_file();
    let stopped = reap_stale_with(&file, terminate_never).await;
    assert_eq!(stopped, 0);
    let records = read_records(&file).await;
    assert!(records.is_empty());
    let _ = tokio::fs::remove_file(&file).await;
}

#[test]
fn identity_matches_when_everything_lines_up() {
    assert!(identity_matches(
        Some((1234, OMP_PATH.to_string())),
        1234,
        OMP_PATH,
        Some(OMP_PATH)
    ));
}

#[test]
fn identity_matches_rejects_a_pid_no_longer_running() {
    assert!(!identity_matches(None, 1234, OMP_PATH, Some(OMP_PATH)));
}

#[test]
fn identity_matches_rejects_a_reused_pid_with_a_different_creation_time() {
    assert!(!identity_matches(
        Some((9999, OMP_PATH.to_string())),
        1234,
        OMP_PATH,
        Some(OMP_PATH)
    ));
}

#[test]
fn identity_matches_rejects_a_different_image_path_even_with_the_same_creation_time() {
    assert!(!identity_matches(
        Some((1234, r"C:\fake\notepad.exe".to_string())),
        1234,
        OMP_PATH,
        Some(OMP_PATH)
    ));
}

#[test]
fn identity_matches_rejects_when_the_live_resolved_omp_path_has_moved() {
    // Security gate-fix: even a pid whose creation time AND recorded image path both still
    // match must never be terminated if that path is no longer what Refract itself would
    // resolve `omp` to right now.
    assert!(!identity_matches(
        Some((1234, OMP_PATH.to_string())),
        1234,
        OMP_PATH,
        Some(r"C:\different\omp.exe")
    ));
}

#[test]
fn identity_matches_rejects_when_omp_cannot_currently_be_resolved_at_all() {
    assert!(!identity_matches(
        Some((1234, OMP_PATH.to_string())),
        1234,
        OMP_PATH,
        None
    ));
}

#[test]
fn identity_matches_is_case_insensitive_on_the_path() {
    assert!(identity_matches(
        Some((1234, OMP_PATH.to_uppercase())),
        1234,
        OMP_PATH,
        Some(&OMP_PATH.to_uppercase())
    ));
}

#[tokio::test]
async fn global_path_init_and_reap_then_record_process_round_trips() {
    // Exercises the REAL `OnceLock`-backed global path (`init_and_reap`/`record_process`/
    // `remove_process_record`), the exact functions `lib.rs` calls at startup and
    // `agent/launch.rs`/`agent/frame.rs` call per spawn/exit -- unlike every other test in this
    // file, which deliberately bypasses the global and calls the `*_with` functions directly
    // against an explicit scratch path. This is the ONE test in the whole binary allowed to
    // touch `FILE_PATH` (a process-wide `OnceLock`, settable once): no other test here calls
    // `init_and_reap`/`record_process`/`remove_process_record`.
    let dir = std::env::temp_dir().join(format!(
        "refract-pid-records-global-test-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    // Deliberately do NOT create `dir` first (falsifies "parent dir missing" as a cause):
    // `write_json_file` itself calls `create_dir_all` on the file's parent before writing.
    assert!(!dir.exists(), "test dir must not already exist");

    let stopped = init_and_reap(&dir).await;
    assert_eq!(stopped, 0, "a fresh, empty directory has nothing to reap");
    let file = dir.join("processes.json");
    assert!(
        file.exists(),
        "init_and_reap must create processes.json even with zero records (mirrors every \
         other test's own reap_stale_with assertion, but through the global OnceLock path)"
    );
    assert!(read_records(&file).await.is_empty());

    record_process(999_999, "global-path-test-session").await;
    let records = read_records(&file).await;
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].pid, 999_999);
    assert_eq!(records[0].session_id, "global-path-test-session");

    remove_process_record(999_999).await;
    assert!(read_records(&file).await.is_empty());
    let _ = tokio::fs::remove_file(&file).await;
}

#[test]
fn walk_descendants_kills_a_simple_chain_and_counts_only_real_terminations() {
    // root(100) -> child(200) -> grandchild(300); every pid passes its own identity check.
    let entries = [(200u32, 100u32), (300u32, 200u32)];
    let mut calls: Vec<(u32, u64)> = Vec::new();
    let killed = walk_descendants(&entries, 100, 1_000, |pid, parent_ticks| {
        calls.push((pid, parent_ticks));
        // Each child's own creation time is one tick after its parent's.
        let ticks = match pid {
            200 => 1_001,
            300 => 1_002,
            _ => unreachable!(),
        };
        Some((ticks, true))
    });
    assert_eq!(killed, 2);
    assert_eq!(calls, vec![(200, 1_000), (300, 1_001)]);
}

#[test]
fn walk_descendants_rejects_a_pid_reused_by_an_older_unrelated_process() {
    // A single entry (200, 100) whose `verify` reports an OLDER creation time than the parent
    // -- some unrelated process now squatting on a pid the real child used to hold, long after
    // it exited. Must never be walked into (no further pids are even offered for it to find).
    let entries = [(200u32, 100u32)];
    let killed = walk_descendants(&entries, 100, 1_000, |_pid, parent_ticks| {
        assert_eq!(parent_ticks, 1_000);
        None // simulates `ticks < parent_creation_ticks` failing the check inside `verify`
    });
    assert_eq!(killed, 0);
}

#[test]
fn walk_descendants_counts_only_successful_terminations_but_still_recurses_on_failure() {
    // child(200) passes identity but its own `TerminateProcess` call fails (already exiting on
    // its own) -- `killed` must not count it, but its OWN child (300) must still be walked.
    let entries = [(200u32, 100u32), (300u32, 200u32)];
    let killed = walk_descendants(&entries, 100, 1_000, |pid, _parent_ticks| match pid {
        200 => Some((1_001, false)),
        300 => Some((1_002, true)),
        _ => unreachable!(),
    });
    assert_eq!(killed, 1);
}

#[test]
fn walk_descendants_visits_every_pid_at_most_once_even_with_a_cycle_in_the_table() {
    // A malformed/raced snapshot claiming (200 -> 100) AND (100 -> 200): without the `visited`
    // guard this would loop forever. `root_pid` (100) is pre-visited, so only 200 is ever
    // offered to `verify`, exactly once.
    let entries = [(200u32, 100u32), (100u32, 200u32)];
    let mut verify_calls = 0;
    let killed = walk_descendants(&entries, 100, 1_000, |pid, _parent_ticks| {
        verify_calls += 1;
        assert_eq!(
            pid, 200,
            "only the non-root pid should ever be offered to verify"
        );
        Some((1_001, true))
    });
    assert_eq!(verify_calls, 1);
    assert_eq!(killed, 1);
}

#[test]
fn walk_descendants_handles_multiple_children_of_the_same_parent() {
    let entries = [(200u32, 100u32), (201u32, 100u32), (202u32, 100u32)];
    let killed = walk_descendants(&entries, 100, 1_000, |_pid, parent_ticks| {
        assert_eq!(parent_ticks, 1_000);
        Some((1_001, true))
    });
    assert_eq!(killed, 3);
}

#[test]
fn walk_descendants_with_no_children_at_all_kills_nothing() {
    let entries: [(u32, u32); 0] = [];
    let killed = walk_descendants(&entries, 100, 1_000, |_pid, _parent_ticks| {
        panic!("verify must never be called with no candidate children");
    });
    assert_eq!(killed, 0);
}
