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
    /// The task ended without a result, so the action may have partly run.
    Lost,
}

/// Spawns `action` with `gate` moved in, so the hold lasts until the action ends and never until the
/// caller stops waiting. `late` gets the result when the caller no longer waits for it.
pub async fn finish_within<T, A, L, LF>(
    deadline: Duration,
    gate: Option<OwnedMutexGuard<()>>,
    action: A,
    late: L,
) -> Waited<T>
where
    T: Send + 'static,
    A: Future<Output = T> + Send + 'static,
    L: FnOnce(T) -> LF + Send + 'static,
    LF: Future<Output = ()> + Send + 'static,
{
    let (tx, mut rx) = oneshot::channel();
    tokio::spawn(async move {
        let result = action.await;
        drop(gate);
        if let Err(unclaimed) = tx.send(result) {
            late(unclaimed).await;
        }
    });
    match tokio::time::timeout(deadline, &mut rx).await {
        Ok(Ok(result)) => Waited::Done(result),
        Ok(Err(_)) => Waited::Lost,
        Err(_) => {
            // Closing first makes a result sent in this instant either arrive here or go to `late`.
            rx.close();
            rx.try_recv().map_or(Waited::StillRunning, Waited::Done)
        }
    }
}

#[cfg(test)]
#[path = "detached_action.test.rs"]
mod tests;
