// Runs a handoff action to completion on its own task (#1861). A deadline only stops the caller
// waiting: dropping the action mid-way would leave omp and the UI disagreeing.

use std::future::Future;
use std::time::Duration;

use tokio::sync::{oneshot, OwnedMutexGuard};

/// What the waiting caller got.
#[derive(Debug, PartialEq, Eq)]
pub enum Waited<T> {
    Done(T),
    /// The deadline passed; the task keeps the gate and finishes the action on its own.
    StillRunning,
    /// The task ended without a result (a panic, say), so the action may have partly run.
    Lost,
}

/// The action's task ended without a result, so `late` hears this in place of the result.
#[derive(Debug, PartialEq, Eq)]
pub struct LostAction;

/// Spawns `action` with `gate` moved in, so the hold lasts until the action ends and never until the
/// caller stops waiting. `late` gets the outcome when the caller no longer waits for it.
pub async fn finish_within<T, A, L, LF>(
    deadline: Duration,
    gate: Option<OwnedMutexGuard<()>>,
    action: A,
    late: L,
) -> Waited<T>
where
    T: Send + 'static,
    A: Future<Output = T> + Send + 'static,
    L: FnOnce(Result<T, LostAction>) -> LF + Send + 'static,
    LF: Future<Output = ()> + Send + 'static,
{
    finish_until(tokio::time::sleep(deadline), gate, action, late).await
}

/// `finish_within` with the moment the caller stops waiting as a future, so a test whose action runs
/// on a real process can end the wait on a signal instead of racing the process's speed to a clock.
pub async fn finish_until<T, A, L, LF, D>(
    deadline: D,
    gate: Option<OwnedMutexGuard<()>>,
    action: A,
    late: L,
) -> Waited<T>
where
    T: Send + 'static,
    A: Future<Output = T> + Send + 'static,
    L: FnOnce(Result<T, LostAction>) -> LF + Send + 'static,
    LF: Future<Output = ()> + Send + 'static,
    D: Future<Output = ()>,
{
    let (tx, mut rx) = oneshot::channel();
    let task = tokio::spawn(async move {
        let result = action.await;
        drop(gate);
        result
    });
    // Owns the sender, so a panic after the caller stopped waiting still reaches `late`.
    tokio::spawn(async move {
        let outcome = match task.await {
            Ok(result) => Ok(result),
            Err(error) => {
                // Fixed text: a panic payload could carry Session data.
                log::warn!(
                    "detached action ended abnormally (panicked: {})",
                    error.is_panic()
                );
                Err(LostAction)
            }
        };
        if let Err(unclaimed) = tx.send(outcome) {
            late(unclaimed).await;
        }
    });
    tokio::select! {
        received = &mut rx => claimed(received.ok()),
        () = deadline => {
            // Closing first makes a result sent in this instant either arrive here or go to `late`.
            rx.close();
            rx.try_recv()
                .map_or(Waited::StillRunning, |outcome| claimed(Some(outcome)))
        }
    }
}

fn claimed<T>(outcome: Option<Result<T, LostAction>>) -> Waited<T> {
    match outcome {
        Some(Ok(result)) => Waited::Done(result),
        Some(Err(LostAction)) | None => Waited::Lost,
    }
}

#[cfg(test)]
#[path = "detached_action.test.rs"]
mod tests;
