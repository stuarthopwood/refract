// Tests for `process::pid_records`, driven by injectable `QueryFn`/`TerminateFn` and scratch files.
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
    // Same pid, different creation time: the OS reused it for another process.
    Some((9999, OMP_PATH.to_string()))
}

fn running_but_different_path(_pid: u32) -> Option<(u64, String)> {
    Some((1234, r"C:\fake\notepad.exe".to_string()))
}

/// Always reports "not a match", for tests that only check `reap_stale_with`'s orchestration.
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
    // Deleting/archiving a Session must leave no stale record for any pid it ever recorded.
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
    // A pid whose identity matches must still not be terminated if the path is no longer what
    // Refract resolves `omp` to.
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
    // The one test allowed to touch the process-wide `FILE_PATH` `OnceLock`; the rest use `*_with`.
    let dir = std::env::temp_dir().join(format!(
        "refract-pid-records-global-test-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    // `dir` is deliberately not created: `write_json_file` must create the missing parent.
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
    // A pid with an older creation time than its parent is an unrelated process; never walk into it.
    let entries = [(200u32, 100u32)];
    let killed = walk_descendants(&entries, 100, 1_000, |_pid, parent_ticks| {
        assert_eq!(parent_ticks, 1_000);
        None // simulates `ticks < parent_creation_ticks` failing the check inside `verify`
    });
    assert_eq!(killed, 0);
}

#[test]
fn walk_descendants_counts_only_successful_terminations_but_still_recurses_on_failure() {
    // A failed terminate is not counted, but that child's own child must still be walked.
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
    // A cyclic snapshot (200 -> 100, 100 -> 200) must not loop; `root_pid` is pre-visited.
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
