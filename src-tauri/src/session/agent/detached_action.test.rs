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
    assert_eq!(*late.lock().await, Some(9));
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
