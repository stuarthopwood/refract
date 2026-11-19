// A detached action finishes whether or not its caller still waits (#1861).

use std::sync::Arc;

use tokio::sync::{Mutex, Notify};

use super::*;

const DEADLINE: Duration = Duration::from_secs(5);

#[tokio::test]
async fn an_action_that_finishes_in_time_hands_back_its_result() {
    let waited = finish_within(DEADLINE, None, async { 7 }, |_| async {}).await;

    assert_eq!(waited, Waited::Done(7));
}

#[tokio::test]
async fn a_late_action_still_finishes_and_its_result_goes_to_the_late_handler() {
    let release = Arc::new(Notify::new());
    let late = Arc::new(Mutex::new(None));
    let gate = Arc::new(Mutex::new(())).lock_owned().await;
    let (waiting, sink) = (release.clone(), late.clone());
    tokio::time::pause();

    let waited = finish_within(
        DEADLINE,
        Some(gate),
        async move {
            waiting.notified().await;
            9
        },
        move |result| async move {
            *sink.lock().await = Some(result);
        },
    )
    .await;
    release.notify_one();
    for _ in 0..100 {
        if late.lock().await.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    assert_eq!(waited, Waited::StillRunning);
    assert_eq!(*late.lock().await, Some(Ok(9)));
}

#[tokio::test]
async fn the_gate_is_held_until_the_action_ends_not_until_the_caller_stops_waiting() {
    let mutex = Arc::new(Mutex::new(()));
    let release = Arc::new(Notify::new());
    let gate = mutex.clone().lock_owned().await;
    let waiting = release.clone();
    tokio::time::pause();

    let waited = finish_within(
        DEADLINE,
        Some(gate),
        async move { waiting.notified().await },
        |_| async {},
    )
    .await;
    let held_after_deadline = mutex.try_lock().is_err();
    release.notify_one();
    let _freed = mutex.lock().await;

    assert_eq!(waited, Waited::StillRunning);
    assert!(held_after_deadline);
}

#[tokio::test]
async fn an_action_that_panics_before_the_deadline_is_lost_and_not_reported_late() {
    let reports = Arc::new(Mutex::new(0));
    let counter = reports.clone();

    let waited = finish_within(
        DEADLINE,
        None,
        async { panic!("boom") },
        move |_: Result<(), LostAction>| async move { *counter.lock().await += 1 },
    )
    .await;
    tokio::time::sleep(Duration::from_millis(50)).await;

    assert_eq!(waited, Waited::Lost);
    assert_eq!(*reports.lock().await, 0, "the waiting caller already knows");
}

#[tokio::test]
async fn an_action_that_panics_after_the_deadline_reports_one_lost_action_late() {
    let release = Arc::new(Notify::new());
    let reports = Arc::new(Mutex::new(Vec::new()));
    let (waiting, sink) = (release.clone(), reports.clone());
    let gate = Arc::new(Mutex::new(())).lock_owned().await;
    tokio::time::pause();

    let waited = finish_within(
        DEADLINE,
        Some(gate),
        async move {
            waiting.notified().await;
            panic!("boom")
        },
        move |outcome: Result<(), LostAction>| async move { sink.lock().await.push(outcome) },
    )
    .await;
    release.notify_one();
    for _ in 0..100 {
        if !reports.lock().await.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    tokio::time::sleep(Duration::from_millis(100)).await;

    assert_eq!(waited, Waited::StillRunning);
    assert_eq!(*reports.lock().await, [Err(LostAction)]);
}
