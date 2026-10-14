// Unit tests for `process::pid_records` (lane R3, issue #786): the record/remove/reap
// read-modify-write logic, driven through the injectable `QueryFn` (and an explicit scratch
// file, never the process-wide `FILE_PATH` global) so these never depend on a real running
// process or on test execution order. `#[path]`-loaded sibling of `pid_records.rs` (excluded
// from `check:file-size` by its own `.test.rs` name).
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

fn always_running_omp(_pid: u32) -> Option<(u64, String)> {
    Some((1234, "omp.exe".to_string()))
}

fn never_running(_pid: u32) -> Option<(u64, String)> {
    None
}

fn running_but_different_process(_pid: u32) -> Option<(u64, String)> {
    // Same pid is now some other process entirely (reused by the OS): a different creation
    // time, so this must never be treated as the same `omp` life.
    Some((9999, "omp.exe".to_string()))
}

fn running_but_not_omp(_pid: u32) -> Option<(u64, String)> {
    Some((1234, "notepad.exe".to_string()))
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
async fn reap_kills_only_pids_that_are_still_the_same_omp_process() {
    let file = scratch_file();
    record_process_with(&file, 10, "session-exited", never_running).await;
    record_process_with(&file, 20, "session-reused", running_but_different_process).await;
    record_process_with(&file, 30, "session-not-omp", running_but_not_omp).await;

    // None of these three records passes `is_same_omp_process` against the query supplied at
    // reap time (see the dedicated unit tests below for that classification rule itself), so
    // `reap_stale_with` never attempts a real `taskkill` against any of these made-up pids and
    // `stopped` stays 0 -- but every record is still cleared from the file regardless, matching
    // the TS port's own "every record has now either been stopped or found stale" contract.
    let stopped = reap_stale_with(&file, always_running_omp).await;
    assert_eq!(stopped, 0);
    let records = read_records(&file).await;
    assert!(
        records.is_empty(),
        "every record is cleared after a reap regardless of outcome"
    );
    let _ = tokio::fs::remove_file(&file).await;
}

#[test]
fn is_same_omp_process_matches_identical_creation_time_and_omp_image() {
    assert!(is_same_omp_process(
        Some((1234, "omp.exe".to_string())),
        1234
    ));
}

#[test]
fn is_same_omp_process_rejects_a_pid_no_longer_running() {
    assert!(!is_same_omp_process(None, 1234));
}

#[test]
fn is_same_omp_process_rejects_a_reused_pid_with_a_different_creation_time() {
    assert!(!is_same_omp_process(
        Some((9999, "omp.exe".to_string())),
        1234
    ));
}

#[test]
fn is_same_omp_process_rejects_the_same_creation_time_but_a_different_image() {
    assert!(!is_same_omp_process(
        Some((1234, "notepad.exe".to_string())),
        1234
    ));
}
#[tokio::test]
async fn reap_with_no_records_is_a_no_op_that_still_clears_the_file() {
    let file = scratch_file();
    let stopped = reap_stale_with(&file, always_running_omp).await;
    assert_eq!(stopped, 0);
    let records = read_records(&file).await;
    assert!(records.is_empty());
    let _ = tokio::fs::remove_file(&file).await;
}
